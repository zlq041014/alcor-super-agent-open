package app.alcor.mobile;

import android.content.Context;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;

final class AttachmentTurnCheck {
    private static final String OWNER = "discussion:fixture", QUESTION = "用这张表，查汇率后计算第二行";

    private static JSONArray prompt() throws Exception {
        return new JSONArray().put(new JSONObject().put("role", "system").put("content", "fixture"))
            .put(new JSONObject().put("role", "user").put("content", QUESTION));
    }

    static String run(Context context) throws Exception {
        var materials = new DiscussionFiles(context);
        String batch = Notes.newId();
        var source = Files.createTempFile(context.getCacheDir().toPath(), "material-", ".xlsx").toFile();
        try {
            Files.write(source.toPath(), "fixture,amount\nsecond,2".getBytes(StandardCharsets.UTF_8));
            var ref = materials.restoreBackupFile(batch, OWNER, source, "表.xlsx", "application/octet-stream").getString("ref");
            var refs = new JSONArray().put(ref);
            var config = new JSONObject().put("endpoint", "https://api.deepseek.com/chat/completions").put("model", "deepseek-flash").put("key", "fixture-only");
            var turns = new ModelTurns();
            var turnId = turns.begin(config, "");
            var turn = turns.require(turnId);
            var uploads = new java.util.concurrent.atomic.AtomicInteger();
            DiscussionFiles.DocumentUploader stub = (model, file, name, purpose) -> {
                if (!"表.xlsx".equals(name) || !"user_data".equals(purpose) || !file.isFile()) throw new AssertionError("附件上传目标不一致");
                uploads.incrementAndGet();
                return "fixture-file-id";
            };
            var first = prompt();
            turn.attach(materials, OWNER, refs, first, () -> turns.require(turnId), stub);
            var follow = prompt().put(new JSONObject().put("role", "assistant").put("content", "正在核对汇率"))
                .put(new JSONObject().put("role", "tool").put("content", "合成汇率：2"));
            turn.attach(materials, OWNER, refs, follow, () -> turns.require(turnId), stub);
            if (uploads.get() != 1 || !first.getJSONObject(1).toString().equals(follow.getJSONObject(1).toString()) ||
                    !"合成汇率：2".equals(follow.getJSONObject(3).getString("content")))
                throw new AssertionError("续包漏材料、重复上传或改写工具回执");
            try { turn.checkSelection(false); throw new AssertionError("允许丢弃选材的续包"); }
            catch (IllegalStateException expected) { if (!expected.getMessage().contains("缺少所选")) throw expected; }
            try {
                turn.attach(materials, OWNER, new JSONArray().put("different"), prompt(), () -> {}, stub);
                throw new AssertionError("续包允许替换附件");
            } catch (IllegalStateException expected) { if (!expected.getMessage().contains("更换所选")) throw expected; }
            var changed = prompt();
            changed.getJSONObject(1).put("content", "另一条问题");
            try {
                turn.attach(materials, OWNER, refs, changed, () -> {}, stub);
                throw new AssertionError("续包允许替换原问题");
            } catch (IllegalStateException expected) { if (!expected.getMessage().contains("原问题已变化")) throw expected; }
            var uncertain = turns.require(turns.begin(config, ""));
            var failed = new java.io.IOException("上传回执中断");
            try {
                uncertain.attach(materials, OWNER, refs, prompt(), () -> {}, (model, file, name, purpose) -> { throw failed; });
                throw new AssertionError("未报告上传中断");
            } catch (java.io.IOException expected) { if (expected != failed) throw expected; }
            try {
                uncertain.attach(materials, OWNER, refs, prompt(), () -> {}, stub);
                throw new AssertionError("本轮自动重传了未确认的附件");
            } catch (IllegalStateException expected) { if (!expected.getMessage().contains("上传未确认")) throw expected; }
            materials.remove(OWNER, ref);
            try { turn.checkAttachments(); throw new AssertionError("移除附件后仍可发送"); }
            catch (IllegalStateException expected) { if (!expected.getMessage().contains("附件已移除")) throw expected; }
            var next = turns.require(turns.begin(new JSONObject(config.toString()).put("endpoint", "https://fixture.invalid/chat/completions"), ""));
            next.checkSelection(false);
            if (uploads.get() != 1) throw new AssertionError("新来源复用了原轮附件");
            return "one upload, same user anchor and tool receipt, removed and new-route checks";
        } finally {
            Files.deleteIfExists(source.toPath());
            materials.discard(batch);
        }
    }
}
