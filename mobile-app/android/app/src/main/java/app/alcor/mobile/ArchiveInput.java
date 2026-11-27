package app.alcor.mobile;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/** Reads entries directly; never extracts or runs a file. */
final class ArchiveInput {
    String text, excerpts, imageName, imageMime;
    byte[] image;
    private static byte[] read(ZipFile zip, ZipEntry item, int max) throws IOException {
        try (var in = zip.getInputStream(item); var out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            for (int n; (n = in.read(buf)) != -1;) {
                if (out.size() + n > max) throw new IOException("ZIP 条目超过读取上限");
                out.write(buf, 0, n);
            }
            return out.toByteArray();
        }
    }
    static ArchiveInput inspect(File file, boolean readImage) {
        ArchiveInput result = new ArchiveInput();
        StringBuilder contents = new StringBuilder(), list = new StringBuilder();
        int left = 160 * 1024;
        try (var zip = new ZipFile(file)) {
            if (zip.size() > 200) throw new IllegalArgumentException("ZIP 超过 200 项，请选取较小的压缩包");
            var entries = zip.entries();
            while (entries.hasMoreElements()) {
                var entry = entries.nextElement();
                if (entry.isDirectory()) continue;
                String name = entry.getName();
                if (name.length() > 512) throw new IllegalArgumentException("ZIP 内文件名过长，无法读取");
                String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
                long size = entry.getSize();
                String status = "仅列文件名";
                if (ext.matches("md|txt|csv|json|log|ya?ml|xml|html|css|py|js|ts|tsx|jsx|java|kt|go|rs|c|cpp|h|cs|toml|ini|sql|sh|gradle|properties")) {
                    if (size >= 0 && size <= Math.min(left, 96 * 1024)) {
                        byte[] bytes = read(zip, entry, Math.min(left, 96 * 1024));
                        left -= bytes.length;
                        try {
                            var decoded = StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes));
                            if (!decoded.toString().trim().isEmpty()) {
                                contents.append("\n\n文件：").append(name).append("\n").append(decoded);
                                status = "已含正文";
                            }
                        } catch (CharacterCodingException e) { status = "非 UTF-8，仅列文件名"; }
                    } else status = "超出文本预算，仅列文件名";
                } else if (ext.matches("png|jpe?g|gif|webp") && result.imageName == null && size > 0 && size <= 4 * 1024 * 1024) {
                    result.imageName = name;
                    result.imageMime = "image/" + ("jpg".equals(ext) ? "jpeg" : ext);
                    if (readImage) result.image = read(zip, entry, 4 * 1024 * 1024);
                    status = readImage ? "随本轮传入图片" : "提问时附带图片";
                }
                list.append(name).append(" · ").append(status).append('\n');
            }
            result.excerpts = contents.toString();
            result.text = "ZIP 文件清单（仅标明已含正文或传入图片的条目可用于内容判断）：\n" + list + result.excerpts;
            return result;
        } catch (IOException | IllegalArgumentException e) {
            if (e instanceof IllegalArgumentException && e.getMessage() != null && e.getMessage().startsWith("ZIP ")) throw (IllegalArgumentException)e;
            throw new IllegalArgumentException("ZIP 无法读取：请检查是否加密、损坏或文件名编码不受支持", e);
        }
    }
}
