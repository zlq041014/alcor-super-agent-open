package app.alcor.mobile;

import android.content.Context;
import android.content.ContextWrapper;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.feature.chat.ChatStore;
import app.alcor.mobile.feature.memory.Memories;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

final class BackupCheck {
    private static final String LIFE = "life:discussion:backup-fixture", NOTE = "a".repeat(32),
        CHAT_FILE = "b".repeat(32), MEMORY = "c".repeat(32), REMINDER = "d".repeat(32);
    private static final String ZIP_META = "alcor-backup.json";

    private static void require(boolean result, String description) {
        if (!result) throw new AssertionError(description);
    }
    private static Context filesIn(Context context, File root) {
        return new ContextWrapper(context) { @Override public File getFilesDir() { return root; } };
    }
    private static ChatStore chats(Database database, Context context) {
        return new ChatStore(database, new File(context.getFilesDir(), "discussions.json"));
    }
    private static LocalBackup.Preview read(File root, byte[] bytes) throws Exception {
        File stage = Files.createTempDirectory(root.toPath(), "stage-").toFile();
        return LocalBackup.read(stage, new ByteArrayInputStream(bytes));
    }

    static String run(Context context) throws Exception {
        String key = UUID.randomUUID().toString();
        String fromName = "backup-source-" + key, toName = "backup-target-" + key;
        File root = Files.createTempDirectory(context.getCacheDir().toPath(), "backup-check-").toFile();
        try (var from = new Database(context, fromName); var to = new Database(context, toName)) {
            checkAbandonedPreviews(root);
            Context source = filesIn(context, new File(root, "source")), target = filesIn(context, new File(root, "target"));
            var sourceFiles = new DiscussionFiles(source); var targetFiles = new DiscussionFiles(target);
            var sourceChat = chats(from, source); var targetChat = chats(to, target);
            File attachment = new File(root, "fixture");
            byte[] payload = {1, 9, 7, 2};
            Files.write(attachment.toPath(), payload);
            JSONObject wx = sourceFiles.restoreBackupFile(CHAT_FILE, LIFE, attachment, "fixture.txt", "text/plain");
            sourceFiles.restoreBackupFile(NOTE, "note:" + NOTE, attachment, "fixture.png", "image/png");
            var msg = new JSONObject().put("id", "fixture-source").put("role", "user").put("text", "一条记录").put("at", "2026-11-25T00:00:00Z");
            var dialog = new JSONObject().put("id", LIFE).put("kind", "discussion").put("title", "生活记录")
                .put("input", "未发草稿").put("messages", new JSONArray().put(msg)).put("wxFiles", new JSONArray().put(wx));
            String peer = "fixture-desktop";
            String remoteId = "[\"fixture-desktop\",\"discussion:test\"]";
            var remote = new JSONObject().put("id", remoteId).put("title", "电脑讨论").put("kind", "discussion")
                .put("peer", peer).put("messages", new JSONArray().put(msg)).put("out", new JSONArray().put("fixture-current-authorization"));
            sourceChat.commit(new JSONObject().put("dialogs", new JSONObject().put(LIFE, dialog).put(remoteId, remote))
                .put("peers", new JSONObject().put(peer, new JSONObject().put("id", peer).put("token", "fixture-never-export")))
                .put("projects", new JSONObject()).put("work", new JSONObject().put("task",
                    new JSONObject().put("id", "task").put("stage", "local").put("command", "fixture-current-authorization"))).toString());
            var sourceDb = from.getWritableDatabase();
            sourceDb.execSQL("INSERT INTO notes(id,mode,body,image,source,created,modified) VALUES(?,'life','图文笔记',?,'app',1,1)",
                new Object[]{NOTE, NOTE + ":0"});
            new Memories(from).add(Mode.LIFE, MEMORY, "本机偏好", "explicit", "chat",
                new JSONArray().put(LIFE).put("fixture-source").toString(), "");
            sourceDb.execSQL("INSERT INTO reminders(id,mode,body,due,origin,origin_ref) VALUES(?,'life','过期提醒',1,'manual','')",
                new Object[]{REMINDER});
            var bytes = new ByteArrayOutputStream();
            JSONObject recordCounts = new LocalBackup(source, from, sourceChat, sourceFiles).write(bytes);
            require(recordCounts.getInt("dialogs") == 2 && recordCounts.getInt("files") == 2, "备份计数不一致");
            String json;
            try (var zip = new ZipInputStream(new ByteArrayInputStream(bytes.toByteArray()))) {
                require(ZIP_META.equals(zip.getNextEntry().getName()), "缺少清单");
                var manifest = new ByteArrayOutputStream();
                var buffer = new byte[1024];
                for (int n; (n = zip.read(buffer)) != -1;) manifest.write(buffer, 0, n);
                json = manifest.toString(StandardCharsets.UTF_8.name());
                require(!json.contains("fixture-never-export") && !json.contains("fixture-current-authorization"), "备份包含授权或凭据");
            }
            var destination = new LocalBackup(target, to, targetChat, targetFiles);
            try (var preview = read(root, bytes.toByteArray())) {
                require(new JSONObject(targetChat.stateJson().isEmpty() ? "{}" : targetChat.stateJson()).length() == 0, "预览写入了本机记录");
                targetFiles.restoreBackupFile(NOTE, "note:" + NOTE, attachment, "existing.png", "image/png");
                try {
                    destination.merge(preview);
                    throw new AssertionError("附件冲突后恢复仍报告成功");
                } catch (java.nio.file.FileAlreadyExistsException expected) {
                    require(targetChat.stateJson().isEmpty(), "附件冲突后的数据库未回滚");
                    try (var dirs = Files.list(targetFiles.directory(NOTE).getParentFile().toPath())) {
                        require(dirs.count() == 1, "附件冲突后留下部分导入文件");
                    }
                }
                targetFiles.discard(NOTE);
                JSONObject merged = destination.merge(preview);
                require(merged.getInt("dialogs") == 2 && merged.getInt("notes") == 1 && merged.getInt("memories") == 1 &&
                    merged.getInt("reminders") == 1 && merged.getInt("files") == 2, "恢复计数不一致");
                var restored = new JSONObject(targetChat.stateJson());
                require(restored.getJSONObject("peers").length() == 0 && restored.getJSONObject("work").length() == 0, "旧配对或派工复活");
                JSONObject dest = restored.getJSONObject("dialogs").getJSONObject(LIFE);
                require("未发草稿".equals(dest.getString("input")) && dest.getJSONArray("messages").length() == 1, "草稿或正文未还原");
                var ref = dest.getJSONArray("wxFiles").getJSONObject(0).getString("ref");
                require(java.util.Arrays.equals(payload, Files.readAllBytes(targetFiles.backupFile(LIFE, ref).toPath())), "附件字节不一致");
                require(java.util.Arrays.equals(payload, Files.readAllBytes(targetFiles.backupFile("note:" + NOTE, NOTE + ":0").toPath())), "笔记图片丢失");
                try (var rows = to.getReadableDatabase().rawQuery("SELECT state FROM reminders WHERE id = ?", new String[]{REMINDER})) {
                    require(rows.moveToFirst() && "blocked".equals(rows.getString(0)), "已过期提醒重新进入调度");
                }
                var memories = new Memories(to);
                memories.delete(Mode.LIFE, MEMORY, false);
                JSONObject repeated = destination.merge(preview);
                require(repeated.getInt("dialogs") == 0 && repeated.getInt("notes") == 0 && repeated.getInt("files") == 0, "重复导入产生副本");
                require(memories.context(Mode.LIFE, "", "").length() == 0, "旧备份复活已删除记忆");
            }
            var corrupt = new ByteArrayOutputStream();
            try (var zip = new ZipOutputStream(corrupt)) {
                zip.putNextEntry(new ZipEntry(ZIP_META)); zip.write(json.getBytes(StandardCharsets.UTF_8)); zip.closeEntry();
            }
            try {
                read(root, corrupt.toByteArray());
                throw new AssertionError("缺附件的备份未拒绝");
            } catch (IllegalArgumentException expected) {
                require(expected.getMessage().contains("备份"), "错误没有备份上下文");
            }
            return "ZIP round trip; exact attachments, credentials excluded, atomic rollback, repeated import and memory tombstone";
        } finally {
            context.deleteDatabase(fromName); context.deleteDatabase(toName);
            try (var entries = Files.walk(root.toPath())) {
                for (Path entry : (Iterable<Path>) entries.sorted(Comparator.reverseOrder())::iterator) Files.delete(entry);
            }
        }
    }

    private static void checkAbandonedPreviews(File root) throws Exception {
        var old = Files.createTempDirectory(root.toPath(), "alcor-restore-");
        var unrelated = Files.createTempDirectory(root.toPath(), "other-temp-");
        Files.write(old.resolve("f0"), new byte[]{1, 2, 3});
        Files.write(unrelated.resolve("keep"), new byte[]{4});
        var scheduled = new java.util.ArrayList<Runnable>();
        LocalBackup.schedulePreviewRecovery(root, scheduled::add);
        require(scheduled.size() == 1, "遗留备份清理没有调度");
        var active = Files.createTempDirectory(root.toPath(), "alcor-restore-");
        Files.write(active.resolve("f0"), new byte[]{5});
        scheduled.get(0).run();
        require(!Files.exists(old) && Files.exists(active.resolve("f0")) && Files.exists(unrelated.resolve("keep")),
            "误删了本进程预览或其他缓存，或者未清理已遗留的预览");
    }
}
