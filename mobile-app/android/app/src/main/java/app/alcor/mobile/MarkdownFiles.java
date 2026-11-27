package app.alcor.mobile;

import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.content.FileProvider;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;

final class MarkdownFiles {
    private static final int PNG_LIMIT = 2 * 1024 * 1024;
    private final Context context;
    private final File root;

    MarkdownFiles(Context context) {
        this.context = context;
        root = new File(context.getCacheDir(), "markdown-export");
    }

    static String name(String title) {
        return displayName(title.replaceFirst("(?i)\\.(md|markdown)$", ""), ".md");
    }

    static String imageName(String title) {
        return displayName(title.replaceFirst("(?i)\\.png$", ""), ".png");
    }

    private static String displayName(String title, String extension) {
        String base = title
            .replaceAll("[\\p{Cntrl}\\\\/:*?\"<>|]", "_").trim().replaceAll("^\\.+|[. ]+$", "");
        if (base.isEmpty()) base = "星引成果";
        int length = Math.min(48, base.codePointCount(0, base.length()));
        return base.substring(0, base.offsetByCodePoints(0, length)) + extension;
    }

    File stage(String text) throws IOException {
        byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
        if (bytes.length == 0 || bytes.length > 512 * 1024) throw new IllegalArgumentException("导出正文为空或超过 512 KiB");
        return stage(bytes, ".md");
    }

    File stagePng(String encoded) throws IOException {
        if (encoded.isEmpty() || encoded.length() > 4 * ((PNG_LIMIT + 2) / 3)) throw new IllegalArgumentException("PNG 超过 2 MiB");
        byte[] bytes = android.util.Base64.decode(encoded, android.util.Base64.NO_WRAP);
        if (bytes.length > PNG_LIMIT) throw new IllegalArgumentException("PNG 超过 2 MiB");
        var options = new android.graphics.BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.length, options);
        if (!"image/png".equals(options.outMimeType) || options.outWidth < 1 || options.outHeight < 1 ||
            options.outWidth > 1600 || options.outHeight > 1600) throw new IllegalArgumentException("导出图片格式或尺寸无效");
        return stage(bytes, ".png");
    }

    private File stage(byte[] bytes, String extension) throws IOException {
        Files.createDirectories(root.toPath());
        long older = System.currentTimeMillis() - 24 * 3600_000L;
        try (var held = Files.newDirectoryStream(root.toPath())) {
            for (var file : held)
                if (tempName(file.getFileName().toString()) && Files.getLastModifiedTime(file).toMillis() < older) Files.deleteIfExists(file);
        }
        File out = new File(root, UUID.randomUUID() + extension);
        Files.write(out.toPath(), bytes, java.nio.file.StandardOpenOption.CREATE_NEW, java.nio.file.StandardOpenOption.WRITE);
        return out;
    }

    File restore(String saved) {
        return saved != null && tempName(saved) ? new File(root, saved) : null;
    }

    private static boolean tempName(String value) { return value.matches("[a-f0-9-]{36}\\.(md|png)"); }
    private static String mime(String name) { return name.endsWith(".png") ? "image/png" : "text/markdown"; }

    static Intent create(String name) {
        return new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mime(name)).putExtra(Intent.EXTRA_TITLE, name);
    }

    Intent share(File file, String name) {
        Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".materials", file, name);
        Intent send = new Intent(Intent.ACTION_SEND).setType(mime(name)).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newUri(context.getContentResolver(), name, uri));
        return Intent.createChooser(send, name.endsWith(".png") ? "分享 PNG" : "分享 Markdown").putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS,
            new android.content.ComponentName[]{new android.content.ComponentName(context, MainActivity.class)});
    }

    void save(File file, Uri destination) throws IOException {
        if (!"content".equals(destination.getScheme())) throw new IOException("保存位置不是系统文档");
        try (var output = context.getContentResolver().openOutputStream(destination, "wt")) {
            if (output == null) throw new IOException("保存位置不可写");
            Files.copy(file.toPath(), output);
        }
    }
}
