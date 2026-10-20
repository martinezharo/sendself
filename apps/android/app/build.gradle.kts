import groovy.json.JsonSlurper
import java.util.Properties

plugins {
    id("com.android.application")
}

/**
 * The package id and hostname are shared with the Worker that serves
 * /.well-known/assetlinks.json, so Digital Asset Links cannot drift from the
 * app that is published.
 */
val twa = JsonSlurper().parse(rootProject.file("../../android.config.json")) as Map<*, *>
val packageId = twa["packageId"] as String
val host = twa["host"] as String
val startUrl = twa["startUrl"] as String

/**
 * The upload key is never committed. Locally it lives in
 * apps/android/keystore.properties (ignored); CI passes the same values as
 * environment variables so the keystore can be written to a temporary path.
 */
val signingProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.exists()) file.inputStream().use(::load)
}

fun signingValue(environment: String, property: String): String? =
    System.getenv(environment)?.takeIf { it.isNotBlank() }
        ?: signingProperties.getProperty(property)?.takeIf { it.isNotBlank() }

val signingStoreFile = signingValue("SENDSELF_KEYSTORE_PATH", "storeFile")
val signingStorePassword = signingValue("SENDSELF_KEYSTORE_PASSWORD", "storePassword")
val signingKeyAlias = signingValue("SENDSELF_KEY_ALIAS", "keyAlias")
val signingKeyPassword = signingValue("SENDSELF_KEY_PASSWORD", "keyPassword")
val hasSigningKey = signingStoreFile != null && signingStorePassword != null && signingKeyAlias != null && signingKeyPassword != null

android {
    namespace = packageId
    compileSdk = 36

    defaultConfig {
        applicationId = packageId
        minSdk = 26
        targetSdk = 36
        versionCode = (project.findProperty("sendselfVersionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("sendselfVersionName") as String?) ?: "1.0.0"

        manifestPlaceholders["twaHost"] = host
        manifestPlaceholders["twaStartUrl"] = startUrl

        // Legacy Digital Asset Links hint used by the FIDO2/credential-sharing
        // flow. Modern App Links verification reads the file from the host.
        resValue(
            "string",
            "asset_statements",
            "[{\\\"include\\\":\\\"https://$host/.well-known/assetlinks.json\\\"}]",
        )
    }

    if (hasSigningKey) {
        signingConfigs {
            create("release") {
                this.storeFile = file(signingStoreFile!!)
                this.storePassword = signingStorePassword
                this.keyAlias = signingKeyAlias
                this.keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // No custom bytecode and no third-party SDK is shipped beyond the
            // browser helper, so shrinking buys little and can strip the
            // manifest-referenced TWA entry points.
            isMinifyEnabled = false
            if (hasSigningKey) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        // Used for the legacy asset_statements resource, generated from
        // android.config.json.
        resValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}

// Play rejects an unsigned bundle, so fail here instead of producing one that
// looks ready. assembleRelease stays usable for inspecting the manifest.
tasks.matching { it.name == "bundleRelease" }.configureEach {
    if (!hasSigningKey) {
        doFirst {
            throw GradleException(
                "Release signing is not configured. Create apps/android/keystore.properties " +
                    "or set SENDSELF_KEYSTORE_PATH, SENDSELF_KEYSTORE_PASSWORD, " +
                    "SENDSELF_KEY_ALIAS and SENDSELF_KEY_PASSWORD.",
            )
        }
    }
}
