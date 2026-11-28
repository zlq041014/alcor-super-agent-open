package app.alcor.mobile;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import androidx.core.content.FileProvider;
import android.util.AtomicFile;
import android.util.Base64;
import java.io.File;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONObject;

final class DiscussionFiles {
    private final File root;
    private final File pendingNotes;
    DiscussionFiles(Context ctx) {
        root = new File(ctx.getFilesDir(), "wechat-files");
        pendingNotes = new File(ctx.getFilesDir(), "note-image-pending");
    }
    static String id(String value) {
        if (!value.matches("[A-Za-z0-9_-]{32}")) throw new IllegalArgumentException("导入编号无效");
        return value;
    }
    File directory(String batch) { return new File(root, id(batch)); }
    static void store(File file, InputStream in, int expected) throws Exception {
        store(file, in, expected, expected);
    }
    private static int store(File file, InputStream in, long expected, int limit) throws Exception {
        AtomicFile target = new AtomicFile(file);
        FileOutputStream out = target.startWrite();
        try {
            byte[] buf = new byte[16384];
            int size = 0, n;
            while ((n = in.read(buf)) != -1) {
                if ((size += n) > limit) throw new IllegalStateException("所选文件超过大小上限");
                out.write(buf, 0, n);
            }
            if (expected >= 0 && size != expected) throw new IllegalStateException("文件尚未接收完整，请重试");
            target.finishWrite(out);
            return size;
        } catch (Exception e) { target.failWrite(out); throw e; }
    }
    JSONObject manifest(File dir) throws Exception {
        return new JSONObject(new String(Files.readAllBytes(new File(dir, "manifest").toPath()), StandardCharsets.UTF_8));
    }
    private static void saveManifest(File dir, JSONObject data) throws Exception {
        byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
        store(new File(dir, "manifest"), new ByteArrayInputStream(bytes), bytes.length);
    }
    JSONObject bind(String batch, String dialog) throws Exception {
        if (dialog.trim().isEmpty() || dialog.length() > 512) throw new IllegalArgumentException("接收讨论无效");
        File dir = directory(batch);
        JSONObject saved = manifest(dir);
        String previous = saved.getString("dialog");
        if (previous.equals(dialog)) return saved;
        if (!previous.isEmpty()) throw new IllegalStateException("这批文件已归入另一场讨论");
        saveManifest(dir, saved.put("dialog", dialog));
        return saved;
    }
    JSONObject importUris(Context ctx, String batch, String dialog, java.util.List<Uri> uris) throws Exception {
        File dir = directory(batch);
        if (new File(dir, "manifest").isFile()) {
            JSONObject saved = manifest(dir);
            if (!saved.getString("dialog").equals(dialog)) throw new IllegalArgumentException("这批文件已加入其他讨论");
            return saved;
        }
        Files.createDirectories(dir.toPath());
        var resolver = ctx.getContentResolver();
        JSONArray files = new JSONArray();
        try {
            for (Uri uri : uris) {
                String name = null, mime = resolver.getType(uri);
                long size = -1;
                try (var cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
                    if (cursor != null && cursor.moveToFirst()) {
                        int n = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME), s = cursor.getColumnIndex(OpenableColumns.SIZE);
                        if (n >= 0) name = cursor.getString(n);
                        if (s >= 0 && !cursor.isNull(s)) size = cursor.getLong(s);
                    }
                }
                if (name == null || name.trim().isEmpty()) name = "手机文件-" + (files.length() + 1);
                if (name.length() > 255) throw new IllegalArgumentException("来源应用没有提供有效的文件名");
                name = name.replaceAll("[\\p{Cntrl}/\\\\]", "_");
                String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
                if (ext != null && !name.contains(".")) name += "." + ext;
                int limit = 20 * 1024 * 1024;
                if (size > limit) throw new IllegalArgumentException("单份手机文件不能超过 20 MiB");
                int index = files.length(), actual;
                try (InputStream in = resolver.openInputStream(uri)) {
                    if (in == null) throw new IllegalStateException("来源应用没有提供可读内容");
                    actual = store(new File(dir, String.valueOf(index)), in, size, limit);
                }
                files.put(new JSONObject().put("ref", batch + ":" + index).put("name", name).put("size", actual)
                    .put("mime", mime == null ? "application/octet-stream" : mime).put("source", "phone"));
            }
            JSONObject saved = new JSONObject().put("id", batch).put("dialog", dialog).put("files", files);
            saveManifest(dir, saved);
            return saved;
        } catch (Exception e) { discard(batch); throw e; }
    }
    void discardUncommittedNoteImage(String id, String owner) throws Exception {
        File previous = directory(id);
        if (new File(previous, "manifest").isFile()) {
            if (!owner.equals(manifest(previous).getString("dialog")))
                throw new IllegalStateException("这份图片编号已被其他材料使用");
            discard(id);
        } else if (noteMarker(id).isFile()) discard(id);
    }

    private File noteMarker(String batch) { return new File(pendingNotes, id(batch)); }

    void beginNoteImage(String batch) throws java.io.IOException {
        Files.createDirectories(pendingNotes.toPath());
        Files.createFile(noteMarker(batch).toPath());
    }

    void finishNoteImage(String batch) throws java.io.IOException {
        Files.deleteIfExists(noteMarker(batch).toPath());
    }

    java.util.List<String> pendingNoteImages() throws java.io.IOException {
        if (!pendingNotes.exists()) return java.util.List.of();
        var ids = new java.util.ArrayList<String>();
        try (var entries = Files.newDirectoryStream(pendingNotes.toPath())) {
            for (var path : entries) ids.add(id(path.getFileName().toString()));
        }
        return ids;
    }

    void discard(String batch) throws Exception {
        File dir = directory(batch);
        if (dir.exists()) {
            try (var entries = Files.newDirectoryStream(dir.toPath())) {
                for (var path : entries) Files.delete(path);
            }
            Files.delete(dir.toPath());
        }
    }
    private File file(String dialog, String ref) throws Exception {
        if (!ref.matches("[A-Za-z0-9_-]{32}:[0-2]")) throw new IllegalArgumentException("附件引用无效");
        File dir = directory(ref.substring(0, 32));
        if (!manifest(dir).getString("dialog").equals(dialog)) throw new IllegalArgumentException("附件不属于当前讨论");
        return new File(dir, ref.substring(33));
    }

    File backupFile(String owner, String ref) throws Exception { return file(owner, ref); }

    JSONObject restoreBackupFile(String batch, String owner, File source, String name, String mime) throws Exception {
        File dir = directory(batch);
        Files.createDirectories(dir.getParentFile().toPath());
        Files.createDirectory(dir.toPath());
        try (InputStream in = Files.newInputStream(source.toPath())) {
            int size = store(new File(dir, "0"), in, source.length(), 20 * 1024 * 1024);
            var info = new JSONObject().put("ref", batch + ":0").put("name", name).put("mime", mime)
                .put("size", size).put("source", "phone").put("selected", false);
            saveManifest(dir, new JSONObject().put("id", batch).put("dialog", owner).put("files", new JSONArray().put(info)));
            return info;
        } catch (Exception failure) {
            try { discard(batch); } catch (Exception cleanup) { failure.addSuppressed(cleanup); }
            throw failure;
        }
    }
    void remove(String dialog, String ref) throws Exception {
        Files.deleteIfExists(file(dialog, ref).toPath());
    }
    JSONObject upload(JSONObject peer, String dialog, String ref, JSONObject request) throws Exception {
        File source = file(dialog, ref);
        JSONObject info = manifest(source.getParentFile()).getJSONArray("files").getJSONObject(Integer.parseInt(source.getName()));
        String name = info.getString("name");
        long size = source.length();
        if (size < 1 || size != info.getLong("size")) throw new IllegalArgumentException("材料缺失、为空或未保存完整");
        request.put("name", name);
        if ("original".equals(request.getString("mode"))) {
            try (var input = new FileInputStream(source)) {
                return Network.material(peer, request, input, size);
            }
        }
        boolean zip = name.toLowerCase(Locale.ROOT).endsWith(".zip");
        String prefix = zip ? "ZIP 仅含文字摘录，未包含原件或图片。\n" : "";
        String suffix = "\n…（正文已截断）";
        int limit = 2500;
        String excerpt;
        if (zip) excerpt = ArchiveInput.inspect(source, false).excerpts.trim();
        else {
            char[] chars = new char[limit + 1];
            try (var reader = new InputStreamReader(new FileInputStream(source), StandardCharsets.UTF_8.newDecoder())) {
                int length = 0;
                while (length < chars.length) {
                    int n = reader.read(chars, length, chars.length - length);
                    if (n < 0) break;
                    length += n;
                }
                excerpt = new String(chars, 0, length);
            }
        }
        if (excerpt.trim().isEmpty()) throw new IllegalArgumentException("材料没有可发送的 UTF-8 正文");
        if (prefix.length() + excerpt.length() > limit) {
            int end = limit - prefix.length() - suffix.length();
            if (Character.isHighSurrogate(excerpt.charAt(end - 1))) end--;
            excerpt = excerpt.substring(0, end) + suffix;
        }
        byte[] bytes = (prefix + excerpt).getBytes(StandardCharsets.UTF_8);
        return Network.material(peer, request, new ByteArrayInputStream(bytes), bytes.length);
    }
    JSONArray branch(String dialog, String to, JSONArray refs) throws Exception {
        return branch(dialog, to, refs, "");
    }
    JSONArray branch(String dialog, String to, JSONArray refs, String noteText) throws Exception {
        boolean note = !noteText.isEmpty();
        int count = refs.length() + (note ? 1 : 0);
        if (count < 1 || count > 3) throw new IllegalArgumentException("请选择 1 至 3 份材料");
        String batch = UUID.randomUUID().toString().replace("-", "");
        File dir = directory(batch);
        Files.createDirectories(dir.toPath());
        try {
            JSONArray staged = new JSONArray();
            for (int i = 0; i < refs.length(); i++) {
                File source = file(dialog, refs.getString(i));
                JSONObject info = manifest(source.getParentFile()).getJSONArray("files").getJSONObject(Integer.parseInt(source.getName()));
                Files.copy(source.toPath(), new File(dir, String.valueOf(i)).toPath());
                staged.put(info.put("ref", batch + ":" + i).put("source", "phone").put("selected", true));
            }
            if (note) {
                int i = refs.length();
                byte[] original = noteText.getBytes(StandardCharsets.UTF_8);
                store(new File(dir, String.valueOf(i)), new ByteArrayInputStream(original), original.length);
                staged.put(new JSONObject().put("ref", batch + ":" + i).put("name", "笔记原文.md")
                    .put("size", original.length).put("mime", "text/markdown").put("source", "phone").put("selected", true));
            }
            byte[] bytes = new JSONObject().put("id", batch).put("dialog", to).put("files", staged).toString().getBytes(StandardCharsets.UTF_8);
            store(new File(dir, "manifest"), new java.io.ByteArrayInputStream(bytes), bytes.length);
            return staged;
        } catch (Exception e) { discard(batch); throw e; }
    }
    JSONObject preview(Context ctx, String dialog, String ref) throws Exception {
        File f = file(dialog, ref);
        JSONObject info = manifest(f.getParentFile()).getJSONArray("files").getJSONObject(Integer.parseInt(f.getName()));
        String name = info.getString("name"), ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
        if ("zip".equals(ext)) return new JSONObject().put("name", name).put("text", ArchiveInput.inspect(f, false).text);
        if (ext.matches("txt|md|csv|json|log") && f.length() <= 128 * 1024) {
            return new JSONObject().put("name", name).put("text", StandardCharsets.UTF_8.newDecoder()
                .decode(java.nio.ByteBuffer.wrap(Files.readAllBytes(f.toPath()))).toString());
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".materials", f, name);
        String mime = info.optString("mime", "");
        if (mime.isEmpty() || mime.equals("application/octet-stream")) mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        var open = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime == null ? "application/octet-stream" : mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        var chooser = Intent.createChooser(open, "用其他应用打开");
        chooser.putExtra(Intent.EXTRA_EXCLUDE_COMPONENTS, new android.content.ComponentName[]{new android.content.ComponentName(ctx, MainActivity.class)});
        ctx.startActivity(chooser);
        return new JSONObject();
    }
    interface CheckPacket { void check() throws Exception; }
    interface DocumentUploader { String upload(JSONObject config, File file, String name, String purpose) throws Exception; }
    private record Upload(JSONObject slot, File file, String name, String purpose) {}
    private record Origin(String ref, long size, long modified) {}

    final class PreparedFiles {
        private final JSONObject config;
        private final String dialog, selection, question;
        private final int index;
        private final JSONArray parts;
        private final List<Origin> origins;
        private final List<Upload> uploads;

        PreparedFiles(JSONObject config, String dialog, JSONArray refs, String question, int index, JSONArray parts,
                      List<Origin> origins, List<Upload> uploads) {
            this.config = config; this.dialog = dialog; this.selection = refs.toString(); this.question = question;
            this.index = index; this.parts = parts; this.origins = origins; this.uploads = uploads;
        }

        boolean matches(String owner, JSONArray refs) { return dialog.equals(owner) && selection.equals(refs.toString()); }

        void check() throws Exception {
            for (var origin : origins) {
                File current = file(dialog, origin.ref());
                if (!current.isFile() || current.length() != origin.size() || current.lastModified() != origin.modified())
                    throw new IllegalStateException("本轮所选附件已移除或变化，请重新选择");
            }
        }

        void apply(JSONArray messages) throws Exception {
            JSONObject anchor = messages.optJSONObject(index);
            if (anchor == null || !"user".equals(anchor.optString("role")) || !question.equals(anchor.opt("content")))
                throw new IllegalStateException("本轮附件的原问题已变化，请重新发送");
            check();
            anchor.put("content", parts);
        }

        void upload(CheckPacket beforeUpload, DocumentUploader uploader) throws Exception {
            for (var upload : uploads) {
                if (upload.slot().has("file_id")) continue;
                beforeUpload.check();
                check();
                upload.slot().put("file_id", uploader.upload(config, upload.file(), upload.name(), upload.purpose()));
            }
        }
    }

    PreparedFiles prepareFiles(JSONObject config, String dialog, JSONArray refs, JSONArray messages) throws Exception {
        if (refs.length() < 1 || refs.length() > 3) throw new IllegalArgumentException("每轮请选择 1 至 3 份材料");
        var uploads = new java.util.ArrayList<Upload>();
        var origins = new java.util.ArrayList<Origin>();
        int index = messages.length() - 1;
        JSONObject last = messages.getJSONObject(index);
        if (!"user".equals(last.optString("role"))) throw new IllegalArgumentException("本轮附件需要绑定用户原问题");
        String question = last.getString("content");
        JSONArray parts = new JSONArray().put(new JSONObject().put("type", "text").put("text", question));
        for (int i = 0; i < refs.length(); i++) {
            String ref = refs.getString(i);
            File file = file(dialog, ref);
            if (!file.isFile()) throw new IllegalStateException("本轮所选附件已移除，请重新选择");
            origins.add(new Origin(ref, file.length(), file.lastModified()));
            String name = manifest(file.getParentFile()).getJSONArray("files").getJSONObject(Integer.parseInt(file.getName())).getString("name");
            String ext = name.substring(name.lastIndexOf('.') + 1).toLowerCase(Locale.ROOT);
            boolean official = Network.usesOfficialModel(config);
            boolean visual = config.getString("model").matches("deepseek-flash|deepseek-v4-flash(?:-vision-exp)?");
            parts.put(new JSONObject().put("type", "text").put("text", "本轮附件（资料）：" + name));
            if ("zip".equals(ext)) {
                ArchiveInput pack = ArchiveInput.inspect(file, true);
                parts.put(new JSONObject().put("type", "text").put("text", pack.text));
                if (pack.image != null) {
                    if (!visual && official) throw new IllegalArgumentException("所选模型不支持 ZIP 中的图片，请切换 V4.1 Flash");
                    parts.put(new JSONObject().put("type", "text").put("text", "归档图片：" + pack.imageName));
                    parts.put(new JSONObject().put("type", "image_url").put("image_url", new JSONObject().put("url",
                        "data:" + pack.imageMime + ";base64," + Base64.encodeToString(pack.image, Base64.NO_WRAP))));
                }
            } else if (ext.matches("png|jpg|jpeg|gif|webp") && official && !visual) {
                throw new IllegalArgumentException("所选模型不支持图片，请切换 V4.1 Flash");
            } else if (ext.matches("png|jpg|jpeg|gif|webp") && official && file.length() > 1024 * 1024) {
                var slot = new JSONObject().put("type", "file");
                parts.put(slot);
                uploads.add(new Upload(slot, file, name, "user_data"));
            } else if (ext.matches("png|jpg|jpeg|gif|webp")) {
                String mime = ext.equals("jpg") ? "jpeg" : ext;
                String image = "data:image/" + mime + ";base64," + Base64.encodeToString(Files.readAllBytes(file.toPath()), Base64.NO_WRAP);
                parts.put(new JSONObject().put("type", "image_url").put("image_url", new JSONObject().put("url", image)));
            } else if (ext.matches("txt|md|csv|json|log")) {
                if (file.length() > 128 * 1024) throw new IllegalArgumentException("文本附件超过本轮 128 KiB 上限，请先缩短");
                String text = StandardCharsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(Files.readAllBytes(file.toPath()))).toString();
                parts.put(new JSONObject().put("type", "text").put("text", text));
            } else if (ext.matches("pdf|docx?|pptx?|xlsx?")) {
                if (!official || !visual) throw new IllegalArgumentException("文档解析需使用 DeepSeek 官方接口和 V4.1 Flash");
                var slot = new JSONObject().put("type", "file");
                parts.put(slot);
                uploads.add(new Upload(slot, file, name, ext.startsWith("xls") ? "user_data" : "text_recognition"));
            } else throw new IllegalArgumentException("此格式已保存，但暂不支持交给模型阅读");
        }
        return new PreparedFiles(config, dialog, refs, question, index, parts, origins, uploads);
    }
    String uploadDocument(JSONObject config, File file, String name, String purpose) throws Exception {
        var c = Network.bearer("https://api.deepseek.com/files", "POST", config.getString("key"));
        String boundary = "alcor-" + UUID.randomUUID();
        StringBuilder form = new StringBuilder();
        String[][] fields = {{"purpose",purpose},{"expires_after[anchor]","created_at"},{"expires_after[seconds]","3600"}};
        for (String[] item : fields) form.append("--").append(boundary).append("\r\nContent-Disposition: form-data; name=\"")
            .append(item[0]).append("\"\r\n\r\n").append(item[1]).append("\r\n");
        String safe = name.replaceAll("[\\p{Cntrl}\"\\\\/]", "_");
        byte[] start = (form + "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + safe +
            "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8);
        byte[] end = ("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8);
        try {
            c.setReadTimeout(120000); c.setDoOutput(true);
            c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
            c.setFixedLengthStreamingMode(start.length + file.length() + end.length);
            try (var stream = c.getOutputStream()) { stream.write(start); Files.copy(file.toPath(), stream); stream.write(end); }
            if (c.getResponseCode() / 100 != 2) throw new IllegalStateException("DeepSeek 文件上传失败，HTTP " + c.getResponseCode());
            return Network.read(c.getInputStream(), 16384).getString("id");
        } finally { c.disconnect(); }
    }
}
