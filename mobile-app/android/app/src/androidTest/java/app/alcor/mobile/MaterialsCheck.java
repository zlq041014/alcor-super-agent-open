package app.alcor.mobile;

import android.app.Activity;
import android.app.Instrumentation;
import android.os.Bundle;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

/** Exercises real Android attachment and request construction, without contacting a model. */
public final class MaterialsCheck extends Instrumentation {
    private boolean workNotices;
    private String invite;
    private String live;
    @Override public void onCreate(Bundle args) { super.onCreate(args); invite = args.getString("invite"); live = args.getString("live"); workNotices = "1".equals(args.getString("workAlerts")); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        DiscussionFiles files = new DiscussionFiles(getTargetContext());
        String batch = UUID.randomUUID().toString().replace("-", "");
        int code = Activity.RESULT_CANCELED;
        try {
            result.putString("attachmentTurn", AttachmentTurnCheck.run(getTargetContext()));
            result.putString("notesMigration", NotesMigrationCheck.run(getTargetContext()));
            result.putString("notesCapture", NotesCaptureCheck.run(getTargetContext()));
            result.putString("chatImport", ChatImportCheck.run(getTargetContext()));
            result.putString("backup", BackupCheck.run(getTargetContext()));
            if (workNotices) result.putString("workNotices", WorkNoticesCheck.run(getTargetContext()));
            if ("1".equals(live)) result.putString("live", LiveCheck.run(getTargetContext()));
            File dir = files.directory(batch);
            Files.createDirectories(dir.toPath());
            try (var zip = new ZipOutputStream(Files.newOutputStream(new File(dir, "0").toPath()))) {
                zip.putNextEntry(new ZipEntry("资料/报价.md"));
                zip.write("样本报价 713".getBytes(StandardCharsets.UTF_8));
                zip.closeEntry(); zip.putNextEntry(new ZipEntry("图.png"));
                zip.write(android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTf0AAAAASUVORK5CYII=", 0));
                zip.closeEntry(); zip.putNextEntry(new ZipEntry("未读.bin")); zip.write(1); zip.closeEntry();
            }
            var manifest = new JSONObject().put("dialog","sample").put("files",new JSONArray().put(new JSONObject().put("name","样本.zip")
                .put("size", new File(dir, "0").length())));
            Files.write(new File(dir,"manifest").toPath(), manifest.toString().getBytes(StandardCharsets.UTF_8));
            var config = new JSONObject().put("model","deepseek-flash").put("effort","high")
                .put("endpoint","https://api.deepseek.com/chat/completions").put("key","fixture-only");
            var refs = new JSONArray().put(batch + ":0");
            var msg = new JSONArray().put(new JSONObject().put("role","user").put("content","核对报价"));
            files.prepareFiles(config, "sample", refs, msg).apply(msg);
            JSONObject body = Network.chatBody(config,msg);
            String content = body.getJSONArray("messages").getJSONObject(0).getJSONArray("content").toString();
            if (!content.contains("样本报价 713") || !content.contains("image_url") || !content.contains("未读.bin · 仅列文件名") ||
                !body.getString("model").equals("deepseek-flash") || !body.getString("reasoning_effort").equals("high"))
                throw new AssertionError("ZIP contents or chosen settings missing from request");
            config.put("model","deepseek-v4-pro").put("effort","none");
            JSONObject pro = Network.chatBody(config, new JSONArray());
            if (!pro.getString("model").equals("deepseek-v4-pro") || pro.has("reasoning_effort") ||
                !pro.getJSONObject("thinking").getString("type").equals("disabled")) throw new AssertionError("model selection lost");
            try { files.prepareFiles(config, "sample", refs, new JSONArray().put(new JSONObject().put("role","user").put("content","test")));
                throw new AssertionError("incompatible model was silently accepted");
            } catch (IllegalArgumentException expected) {
                if (!expected.getMessage().contains("切换")) throw expected;
            }
            if (invite != null) {
                handoff(files, batch + ":0");
                result.putString("handoff", "Android ZIP excerpt uploaded and queued on isolated pinned HTTPS hub");
            }
            exportFiles();
            exportImage();
            result.putString("export", "Markdown URI share grant and save preserve exact UTF-8 bytes");
            result.putString("checks","ZIP text + image, explicit omissions, Flash High, Pro off, incompatible model stopped");
            code = Activity.RESULT_OK;
        } catch (Exception | AssertionError e) { result.putString("error", describe(e)); }
        finally {
            try { files.discard(batch); } catch (Exception e) { result.putString("cleanup",e.toString()); code = Activity.RESULT_CANCELED; }
            finish(code,result);
        }
    }

    private static String describe(Throwable error) {
        var text = new java.io.StringWriter();
        error.printStackTrace(new java.io.PrintWriter(text));
        return text.toString();
    }

    @SuppressWarnings("deprecation")
    private void exportImage() throws Exception {
        var exports = new MarkdownFiles(getTargetContext());
        var bitmap = android.graphics.Bitmap.createBitmap(4, 3, android.graphics.Bitmap.Config.ARGB_8888);
        var bytes = new java.io.ByteArrayOutputStream();
        bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, bytes);
        bitmap.recycle();
        String encoded = android.util.Base64.encodeToString(bytes.toByteArray(), android.util.Base64.NO_WRAP);
        var image = exports.stagePng(encoded);
        try {
            String name = MarkdownFiles.imageName("手机/架构.png");
            android.content.Intent target = exports.share(image, name).getParcelableExtra(android.content.Intent.EXTRA_INTENT);
            if (!"手机_架构.png".equals(name) || !"image/png".equals(MarkdownFiles.create(name).getType()) ||
                !"image/png".equals(target.getType()) || !java.util.Arrays.equals(bytes.toByteArray(), Files.readAllBytes(image.toPath())))
                throw new AssertionError("架构图导出格式或字节不一致");
            try {
                exports.stagePng("bm90LWEtcG5n");
                throw new AssertionError("无效图片未拒绝");
            } catch (IllegalArgumentException expected) {
                if (!expected.getMessage().contains("图片")) throw expected;
            }
        } finally { Files.delete(image.toPath()); }
    }

    @SuppressWarnings("deprecation")
    private void exportFiles() throws Exception {
        var markdown = new MarkdownFiles(getTargetContext());
        String text = "## 中文成果\r\n\r\n- 原文 😀\n\n### 出处\n\n- 材料：附件.txt\n";
        String name = MarkdownFiles.name("讨论/产物.markdown");
        if (!name.equals("讨论_产物.md") || !MarkdownFiles.create(name).getStringExtra(android.content.Intent.EXTRA_TITLE).equals(name))
            throw new AssertionError("invalid Markdown filename");
        var file = markdown.stage(text);
        var destination = markdown.stage("原内容应被覆盖".repeat(10));
        try {
            android.content.Intent target = markdown.share(file, name).getParcelableExtra(android.content.Intent.EXTRA_INTENT);
            android.net.Uri uri = target.getParcelableExtra(android.content.Intent.EXTRA_STREAM);
            if (!"text/markdown".equals(target.getType()) ||
                    (target.getFlags() & android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION) == 0)
                throw new AssertionError("missing scoped share grant");
            var resolver = getTargetContext().getContentResolver();
            try (var shared = resolver.openInputStream(uri)) {
                if (!java.util.Arrays.equals(shared.readAllBytes(), text.getBytes(StandardCharsets.UTF_8)))
                    throw new AssertionError("shared UTF-8 bytes changed");
            }
            var output = androidx.core.content.FileProvider.getUriForFile(getTargetContext(),
                getTargetContext().getPackageName() + ".materials", destination);
            markdown.save(file, output);
            if (!java.util.Arrays.equals(Files.readAllBytes(destination.toPath()), text.getBytes(StandardCharsets.UTF_8)))
                throw new AssertionError("saved UTF-8 bytes changed");
        } finally {
            Files.delete(file.toPath());
            Files.delete(destination.toPath());
        }
    }

    private void handoff(DiscussionFiles files, String ref) throws Exception {
        var peer = new JSONObject(new String(android.util.Base64.decode(invite.substring(7),
            android.util.Base64.URL_SAFE), StandardCharsets.UTF_8));
        var pair = Network.desktop(peer, "pair", new JSONObject()).getJSONObject("pair");
        peer.put("token", pair.getString("token"));
        var catalog = Network.desktop(peer, "catalog", new JSONObject()).getJSONObject("value");
        var project = catalog.getJSONArray("projects").getJSONObject(0);
        var command = new JSONObject().put("id", UUID.randomUUID().toString()).put("projectId", project.getString("id"))
            .put("version", project.getString("version")).put("expiresAt", System.currentTimeMillis() + 60_000)
            .put("target", new JSONObject().put("backend", "dsh").put("mode", "read"))
            .put("goal", "隔离核对 ZIP 摘录").put("acceptance", "核对正文及来源");
        var info = new JSONObject().put("requestId", command.getString("id")).put("slot", 0).put("count", 1)
            .put("projectId", command.getString("projectId")).put("version", command.getString("version"))
            .put("expiresAt", command.getLong("expiresAt")).put("mode", "excerpt");
        var uploaded = files.upload(peer, "sample", ref, info).getJSONObject("value");
        command.put("materials", new JSONArray().put(uploaded));
        var response = Network.desktop(peer, "command", new JSONObject().put("value", command)).getJSONObject("value");
        if (response.getInt("materialCount") != 1 || response.has("materialInputs") || !response.getString("stage").equals("queued"))
            throw new AssertionError("expected complete upload, without claiming an executed turn");
    }
}
