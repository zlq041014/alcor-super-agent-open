package app.alcor.mobile;

import android.content.Context;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.feature.chat.ChatStore;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Iterator;
import org.json.JSONArray;
import org.json.JSONObject;

/** Imports a fixture shaped like the shipped discussions.json and checks backup, counts and round trip. */
final class ChatImportCheck {
    private ChatImportCheck() {
    }

    static String run(Context context) throws Exception {
        File root = new File(context.getFilesDir(), "chat-import-check-" + java.util.UUID.randomUUID());
        Files.createDirectories(root.toPath());
        String databaseName = "chat-import-check.db";
        context.deleteDatabase(databaseName);
        try {
            JSONObject fixture = fixture();
            byte[] original = fixture.toString().getBytes(StandardCharsets.UTF_8);
            File legacy = new File(root, "discussions.json");
            Files.write(legacy.toPath(), original);

            JSONObject expectedCounts;
            try (Database database = new Database(context, databaseName)) {
                ChatStore store = new ChatStore(database, legacy);
                String state = store.stateJson();
                if (!store.imported()) throw new AssertionError("旧记录没有标记为已迁移");
                JSONObject report = store.importReport();
                if (!"legacy".equals(report.getString("source"))) throw new AssertionError("迁移来源记录错误");
                File backup = new File(root, report.getString("backup"));
                if (!backup.isFile()) throw new AssertionError("迁移备份不存在");
                if (!Arrays.equals(original, Files.readAllBytes(backup.toPath())))
                    throw new AssertionError("迁移备份与旧记录字节不一致");
                if (!Arrays.equals(original, Files.readAllBytes(legacy.toPath())))
                    throw new AssertionError("迁移改动了旧记录文件");
                if (!same(fixture, new JSONObject(state))) throw new AssertionError("迁移快照与旧记录不一致");
                expectedCounts = report.getJSONObject("counts");
                if (!same(expectedCounts, store.counts())) throw new AssertionError("迁移计数表与数据库不一致");
                if (expectedCounts.getInt("dialogs") != 4 || expectedCounts.getInt("messages") != 7 ||
                    expectedCounts.getInt("decisions") != 1 || expectedCounts.getInt("work") != 1 ||
                    expectedCounts.getInt("peers") != 1 || expectedCounts.getInt("projects") != 1 ||
                    expectedCounts.getInt("artifacts") != 1) throw new AssertionError("样例计数不符合预期: " + expectedCounts);

                int backups = backups(root);
                if (!state.equals(store.stateJson())) throw new AssertionError("重复读取快照不稳定");
                if (backups(root) != backups) throw new AssertionError("重复打开又写了一次备份");

                JSONObject changed = new JSONObject(state);
                JSONObject dialog = changed.getJSONObject("dialogs").getJSONObject("discussion:local");
                dialog.put("input", "改过的草稿");
                dialog.getJSONArray("messages").put(new JSONObject().put("id", "m-local-4")
                    .put("role", "user").put("text", "新的一条").put("at", "2026-11-25T08:00:00.000Z"));
                changed.put("last", "discussion:local");
                store.commit(changed.toString());
                JSONObject after = new JSONObject(store.stateJson());
                if (!same(changed, after)) throw new AssertionError("提交后快照与写入内容不一致");
                if (store.counts().getInt("messages") != 8) throw new AssertionError("提交后消息计数没有增加");
            } finally {
                context.deleteDatabase(databaseName);
            }

            String brokenName = "chat-import-broken.db";
            context.deleteDatabase(brokenName);
            try {
                File broken = new File(root, "broken.json");
                byte[] bytes = "{\"dialogs\":{\"x\":{\"id\":\"x\",\"messages\":[".getBytes(StandardCharsets.UTF_8);
                Files.write(broken.toPath(), bytes);
                try (Database database = new Database(context, brokenName)) {
                    ChatStore store = new ChatStore(database, broken);
                    store.stateJson();
                    throw new AssertionError("损坏的旧记录被静默迁移");
                } catch (IllegalStateException expected) {
                    if (!expected.getMessage().contains("旧记录")) throw expected;
                }
                if (!Arrays.equals(bytes, Files.readAllBytes(broken.toPath())))
                    throw new AssertionError("迁移失败时改动了旧记录");
                if (backups(root) != 1) throw new AssertionError("损坏记录不应留下备份");
                try (Database database = new Database(context, brokenName)) {
                    ChatStore store = new ChatStore(database, broken);
                    if (store.imported() || store.counts().getInt("dialogs") != 0)
                        throw new AssertionError("迁移失败后仍写入了半份数据");
                    JSONObject empty = new JSONObject().put("dialogs", new JSONObject()).put("projects", new JSONObject())
                        .put("peers", new JSONObject()).put("work", new JSONObject());
                    store.commit(empty.toString());
                    if (!store.imported()) throw new AssertionError("首次提交后没有登记数据库来源");
                }
            } finally {
                context.deleteDatabase(brokenName);
            }
            realData(context);
            return "legacy import preserved bytes and counts, snapshot round trip, commit, malformed import rejected";
        } finally {
            try (var paths = Files.walk(root.toPath())) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (java.io.IOException ignored) { }
                });
            }
        }
    }

    /** Imports a copy of the device's current records into a throwaway database before the app upgrades itself. */
    private static void realData(Context context) throws Exception {
        File real = new File(context.getFilesDir(), "discussions.json");
        if (!real.isFile() || real.length() == 0) return;
        File temp = new File(context.getCacheDir(), "chat-import-real-" + java.util.UUID.randomUUID());
        Files.createDirectories(temp.toPath());
        File copy = new File(temp, "discussions.json");
        Files.copy(real.toPath(), copy.toPath());
        String name = "chat-import-real.db";
        context.deleteDatabase(name);
        JSONObject source = new JSONObject(new String(Files.readAllBytes(copy.toPath()), StandardCharsets.UTF_8));
        try (Database database = new Database(context, name)) {
            ChatStore store = new ChatStore(database, copy);
            JSONObject state = new JSONObject(store.stateJson());
            if (!same(source, state)) throw new AssertionError("真机记录快照与原文件不一致");
            JSONObject report = store.importReport();
            if (!same(report.getJSONObject("counts"), store.counts()))
                throw new AssertionError("真机记录迁移计数与数据库不一致");
        } finally {
            context.deleteDatabase(name);
            try (var paths = Files.walk(temp.toPath())) {
                paths.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                    try { Files.deleteIfExists(path); } catch (java.io.IOException ignored) { }
                });
            }
        }
    }

    private static int backups(File root) throws Exception {
        String[] names = root.list((dir, name) -> name.startsWith("discussions.bak.") && name.endsWith(".json"));
        return names == null ? 0 : names.length;
    }

    private static JSONObject fixture() throws Exception {
        String projectKey = "[\"pc\",\"project-1\"]";
        JSONObject fixture = new JSONObject();
        fixture.put("peers", new JSONObject().put("pc", new JSONObject().put("id", "pc").put("name", "工作电脑")
            .put("grant", "read").put("online", false).put("cursor", 7).put("at", "2026-11-24T05:00:00.000Z")));
        fixture.put("projects", new JSONObject().put(projectKey, new JSONObject().put("id", "project-1")
            .put("key", projectKey).put("peer", "pc").put("name", "alcor-web").put("version", "v1")
            .put("backend", "dsh").put("shared", true)));
        JSONObject dialogs = new JSONObject();
        dialogs.put("home", new JSONObject().put("id", "home").put("kind", "home").put("title", "星引总管")
            .put("input", "还没发的话").put("used", 0).put("messages", new JSONArray()
                .put(message("m-home-1", "user", "你好", "2026-11-24T04:00:00.000Z"))
                .put(message("m-home-2", "assistant", "你好，我是星引。", "2026-11-24T04:00:01.000Z"))));
        dialogs.put("discussion:local", new JSONObject().put("id", "discussion:local").put("kind", "discussion")
            .put("title", "本机新对话").put("input", "草稿").put("own", true).put("listed", true)
            .put("autoTitle", true).put("used", 1764000000000L).put("messages", new JSONArray()
                .put(message("m-local-1", "user", "随手记的想法", "2026-11-24T04:01:00.000Z"))
                .put(message("m-local-2", "assistant", "先记下来。", "2026-11-24T04:01:02.000Z"))
                .put(message("m-local-3", "system", "", "2026-11-24T04:01:03.000Z").put("kind", "search")))
            .put("decisions", new JSONArray().put(new JSONObject().put("id", "d-1")
                .put("heads", new JSONArray().put("v-1")).put("versions", new JSONArray().put(new JSONObject()
                    .put("id", "d-1").put("version", "v-1").put("parents", new JSONArray())
                    .put("text", "继续").put("quote", "就用继续").put("origin", "手机").put("at", "2026-11-24T04:02:00.000Z"))))));
        JSONObject shared = new JSONObject().put("id", "[\"pc\",\"room-1\"]").put("remote", "room-1")
            .put("kind", "discussion").put("title", "登录页改版").put("project", projectKey).put("peer", "pc")
            .put("session", new JSONObject().put("backend", "codex").put("threadId", "ori"))
            .put("dirty", true).put("out", new JSONArray().put(new JSONObject().put("id", "m-out")
                .put("role", "user").put("text", "待同步").put("at", "2026-11-24T04:05:00.000Z")))
            .put("decisionOut", new JSONArray()).put("wxFiles", new JSONArray().put(new JSONObject()
                .put("ref", "batch:0").put("name", "资料.md").put("size", 12).put("mime", "text/markdown")
                .put("source", "phone").put("selected", true)))
            .put("messages", new JSONArray().put(message("m-shared-1", "user", "改标题", "2026-11-24T04:03:00.000Z")))
            .put("history", new JSONObject().put("at", "2026-11-24T04:04:00.000Z").put("gap", true)
                .put("cursor", 9).put("epoch", "e1").put("offline", false)
                .put("messages", new JSONArray().put(new JSONObject().put("id", "remote-1")
                    .put("role", "assistant").put("text", "桌面已同步的正文").put("at", "2026-11-24T04:04:00.000Z"))));
        dialogs.put(shared.getString("id"), shared);
        dialogs.put("[\"pc\",\"native-1\"]", new JSONObject().put("id", "[\"pc\",\"native-1\"]")
            .put("kind", "codex").put("title", "原会话登录页").put("project", projectKey).put("peer", "pc")
            .put("session", new JSONObject().put("backend", "codex").put("threadId", "ori"))
            .put("listed", true).put("history", new JSONObject().put("at", "2026-11-24T04:06:00.000Z")
                .put("messages", new JSONArray())));
        fixture.put("dialogs", dialogs);
        fixture.put("work", new JSONObject().put("w-1", new JSONObject().put("id", "w-1")
            .put("dialog", shared.getString("id")).put("project", projectKey).put("peer", "pc")
            .put("stage", "sending").put("goal", "调整标题").put("acceptance", "回到讨论说明")
            .put("target", new JSONObject().put("backend", "codex").put("mode", "write"))
            .put("command", new JSONObject().put("id", "w-1")).put("refs", new JSONArray())
            .put("materials", new JSONArray()).put("log", new JSONArray())
            .put("receipt", new JSONObject().put("stage", "queued").put("detail", "已登记"))));
        fixture.put("last", "2026-11-24T05:00:00.000Z");
        fixture.put("lastDiscussion", "discussion:local");
        fixture.put("artifactCache", new JSONArray().put(new JSONObject().put("key", "[\"pc\",\"w-1\"]")
            .put("name", "交付.md").put("text", "# 已核对").put("at", "2026-11-24T04:07:00.000Z")));
        fixture.put("otherSetting", new JSONObject().put("compact", true));
        return fixture;
    }

    private static JSONObject message(String id, String role, String text, String at) throws Exception {
        return new JSONObject().put("id", id).put("role", role).put("text", text).put("at", at);
    }

    private static boolean same(Object left, Object right) {
        if (left == null || right == null || left == JSONObject.NULL || right == JSONObject.NULL)
            return left == right || left == JSONObject.NULL && right == JSONObject.NULL;
        if (left instanceof JSONObject a && right instanceof JSONObject b) {
            if (a.length() != b.length()) return false;
            for (Iterator<String> keys = a.keys(); keys.hasNext(); ) {
                String key = keys.next();
                if (!b.has(key) || !same(a.opt(key), b.opt(key))) return false;
            }
            return true;
        }
        if (left instanceof JSONArray a && right instanceof JSONArray b) {
            if (a.length() != b.length()) return false;
            for (int i = 0; i < a.length(); i++) if (!same(a.opt(i), b.opt(i))) return false;
            return true;
        }
        if (left instanceof Number && right instanceof Number)
            return ((Number) left).doubleValue() == ((Number) right).doubleValue();
        return left.equals(right);
    }
}
