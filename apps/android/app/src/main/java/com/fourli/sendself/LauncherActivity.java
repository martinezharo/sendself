package com.fourli.sendself;

/**
 * The Trusted Web Activity entry point.
 *
 * Everything is configured through AndroidManifest metadata (default URL,
 * colours, splash) and verified with Digital Asset Links, so there is no custom
 * launch logic to keep in sync with the PWA.
 */
public final class LauncherActivity
        extends com.google.androidbrowserhelper.trusted.LauncherActivity {
}
