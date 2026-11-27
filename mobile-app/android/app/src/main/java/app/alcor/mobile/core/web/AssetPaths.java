package app.alcor.mobile.core.web;

import java.util.regex.Pattern;

/** Restricts the WebView to bundled assets and a known set of file types. */
public final class AssetPaths {
    private static final Pattern ALLOWED = Pattern.compile(
        "/(?:index[.]html" +
            "|[a-z0-9_-]+[.](?:js|css)" +
            "|(?:core|features|ui|styles)/(?:[a-z0-9_-]+/)*[a-z0-9_-]+[.](?:js|css)" +
            "|assets/(?:[a-z0-9_-]+/)*[a-z0-9_-]+[.](?:png|webp|jpg|jpeg))");

    private AssetPaths() {
    }

    public static boolean allows(String path) {
        return path != null && !path.contains("..") && ALLOWED.matcher(path).matches();
    }

    public static String mime(String path) {
        if (path.endsWith(".js")) return "text/javascript";
        if (path.endsWith(".css")) return "text/css";
        if (path.endsWith(".html")) return "text/html";
        if (path.endsWith(".png")) return "image/png";
        if (path.endsWith(".webp")) return "image/webp";
        if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
        return "application/octet-stream";
    }
}
