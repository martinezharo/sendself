/**
 * The only script the static pages (security, privacy, 404) load.
 *
 * Their content is prerendered HTML and never hydrated, so all this does is
 * bring the site's styles and apply the appearance chosen in the app — the
 * same colours on every page, without shipping the app to read a document.
 */
import "../styles";
import { initAppearance } from "../state/appearance";

initAppearance();
