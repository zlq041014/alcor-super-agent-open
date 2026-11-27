package app.alcor.mobile.core.web;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public final class AssetPathsTest {
    @Test public void allowsBundledUiFiles() {
        assertTrue(AssetPaths.allows("/index.html"));
        assertTrue(AssetPaths.allows("/app.js"));
        assertTrue(AssetPaths.allows("/styles.css"));
        assertTrue(AssetPaths.allows("/core/bridge.js"));
        assertTrue(AssetPaths.allows("/features/notes/list.css"));
        assertTrue(AssetPaths.allows("/ui/components.js"));
        assertTrue(AssetPaths.allows("/styles/tokens.css"));
        assertTrue(AssetPaths.allows("/assets/avatar.png"));
        assertTrue(AssetPaths.allows("/assets/pet/idle.webp"));
    }

    @Test public void rejectsTraversalAndUnknownFiles() {
        assertFalse(AssetPaths.allows(null));
        assertFalse(AssetPaths.allows("/../secret.js"));
        assertFalse(AssetPaths.allows("/core/../app.js"));
        assertFalse(AssetPaths.allows("/assets/../x.png"));
        assertFalse(AssetPaths.allows("/core//bridge.js"));
        assertFalse(AssetPaths.allows("/CORE/bridge.js"));
        assertFalse(AssetPaths.allows("/core/readme.txt"));
        assertFalse(AssetPaths.allows("/assets/pet/idle.svg"));
        assertFalse(AssetPaths.allows("//app.js"));
    }

    @Test public void returnsKnownMimeTypes() {
        assertEquals("text/javascript", AssetPaths.mime("/app.js"));
        assertEquals("text/css", AssetPaths.mime("/styles/tokens.css"));
        assertEquals("text/html", AssetPaths.mime("/index.html"));
        assertEquals("image/png", AssetPaths.mime("/assets/avatar.png"));
        assertEquals("image/webp", AssetPaths.mime("/assets/pet/idle.webp"));
        assertEquals("application/octet-stream", AssetPaths.mime("/assets/pet/idle.svg"));
    }
}
