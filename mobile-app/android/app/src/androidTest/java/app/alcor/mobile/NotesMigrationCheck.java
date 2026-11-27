package app.alcor.mobile;

import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.feature.memory.Memories;
import java.io.File;
import org.json.JSONObject;

/** Opens a v1 notes database with the current schema and checks migration plus note operations. */
final class NotesMigrationCheck {
    private static final String NAME = "notes-migration-check.db";
    private static final String ID = "0123456789abcdef0123456789abcdef";
    private static final String SECOND = "fedcba9876543210fedcba9876543210";

    private NotesMigrationCheck() {
    }

    static String run(Context context) throws Exception {
        context.deleteDatabase(NAME);
        try {
            File path = context.getDatabasePath(NAME);
            if (path.getParentFile() != null) path.getParentFile().mkdirs();
            SQLiteDatabase v1 = SQLiteDatabase.openOrCreateDatabase(path, null);
            Database.createNotesV1(v1);
            v1.execSQL("INSERT INTO notes (id, body, image, project, source, created, modified) VALUES (?, ?, NULL, '', 'app', 1, 1)",
                new Object[]{ID, "迁移前的原文"});
            v1.setVersion(1);
            v1.close();

            try (Database database = new Database(context, NAME)) {
                Notes notes = new Notes(context, database, new DiscussionFiles(context));
                JSONObject note = notes.get(Mode.WORK, ID);
                if (!"迁移前的原文".equals(note.getString("text")))
                    throw new AssertionError("迁移后笔记原文不一致");
                if (notes.inboxCount(Mode.LIFE) != 0) throw new AssertionError("旧笔记串入生活模式");
                notes.addText(Mode.LIFE, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "生活迁移样本", "app");
                if (notes.list(Mode.WORK, "生活迁移样本", 0, "").getJSONArray("notes").length() != 0 ||
                    notes.inboxCount(Mode.LIFE) != 1) throw new AssertionError("笔记检索或计数未按模式隔离");
                try { notes.get(Mode.LIFE, ID); throw new AssertionError("按编号跨读了工作笔记"); }
                catch (IllegalArgumentException expected) {
                    if (!expected.getMessage().contains("不存在")) throw expected;
                }
                if (!Notes.INBOX.equals(note.getString("box")))
                    throw new AssertionError("v3 迁移后旧笔记不在收件箱");
                boolean projectIndex = false, boxIndex = false;
                try (Cursor rows = database.getReadableDatabase().rawQuery("PRAGMA index_list(notes)", null)) {
                    while (rows.moveToNext()) {
                        if ("notes_project_recent".equals(rows.getString(1))) projectIndex = true;
                        if ("notes_box_recent".equals(rows.getString(1))) boxIndex = true;
                    }
                }
                if (!projectIndex || !boxIndex) throw new AssertionError("v2 或 v3 索引没有创建");
                try (Cursor tables = database.getReadableDatabase().rawQuery(
                        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN " +
                            "('dialogs','messages','decisions','work','peers','projects','artifacts','meta')", null)) {
                    tables.moveToFirst();
                    if (tables.getInt(0) != 8) throw new AssertionError("v4 聊天表没有创建");
                }

                notes.addText(Mode.WORK, SECOND, "收件箱里的新原文", "app");
                JSONObject created = notes.get(Mode.WORK, SECOND);
                if (!Notes.INBOX.equals(created.getString("box"))) throw new AssertionError("新笔记没有进收件箱");
                if (notes.list(Mode.WORK, "新原文", 0, Notes.INBOX).getJSONArray("notes").length() != 1)
                    throw new AssertionError("中文子串检索没有命中");
                if (notes.list(Mode.WORK, "新原文", 0, Notes.FILED).getJSONArray("notes").length() != 0)
                    throw new AssertionError("状态筛选没有生效");
                JSONObject filed = notes.update(Mode.WORK, SECOND, "改过的原文", "project-a", Notes.FILED);
                if (!"改过的原文".equals(filed.getString("text")) || !"project-a".equals(filed.getString("project")) ||
                    !Notes.FILED.equals(filed.getString("box"))) throw new AssertionError("编辑或挂项目没有保存");
                if (notes.inboxCount(Mode.WORK) != 1) throw new AssertionError("收件箱计数不一致");
                notes.setBox(Mode.WORK, SECOND, Notes.ARCHIVED);
                if (!Notes.ARCHIVED.equals(notes.get(Mode.WORK, SECOND).getString("box"))) throw new AssertionError("归档没有保存");
                notes.delete(Mode.WORK, SECOND);
                try { notes.get(Mode.WORK, SECOND); throw new AssertionError("删除后仍能读到笔记"); }
                catch (IllegalArgumentException expected) {
                    if (!expected.getMessage().contains("不存在")) throw expected;
                }
                notes.addText(Mode.WORK, SECOND, "从对话记下的原文", "assistant");
                notes.addText(Mode.WORK, SECOND, "重试不重写", "assistant");
                if (!"从对话记下的原文".equals(notes.get(Mode.WORK, SECOND).getString("text")))
                    throw new AssertionError("同一写入编号被重写");
                notes.undoAssistantAdd(Mode.WORK, SECOND);
                notes.undoAssistantAdd(Mode.WORK, SECOND);
                if (notes.inboxCount(Mode.WORK) != 1) throw new AssertionError("撤销未移除助手笔记");
                notes.addText(Mode.WORK, SECOND, "会被编辑", "assistant");
                notes.update(Mode.WORK, SECOND, "保留这条修改", "", Notes.INBOX);
                try { notes.undoAssistantAdd(Mode.WORK, SECOND); throw new AssertionError("撤销删除了编辑后的笔记"); }
                catch (IllegalArgumentException expected) {
                    if (!expected.getMessage().contains("已改动")) throw expected;
                }
            }
            try (Database database = new Database(context, NAME)) {
                var memories = new Memories(database);
                String life = "cccccccccccccccccccccccccccccccc", work = "dddddddddddddddddddddddddddddddd";
                memories.add(Mode.LIFE, life, "生活记忆夹具", "candidate", "chat", "[\"home:life\",\"m1\"]", "");
                memories.add(Mode.WORK, work, "项目记忆夹具", "explicit", "chat", "[\"home\",\"m2\"]", "project-a");
                if (memories.context(Mode.LIFE, "", "").length() != 0 ||
                    memories.context(Mode.WORK, "project-b", "").length() != 0 ||
                    memories.context(Mode.WORK, "project-a", "").length() != 1) throw new AssertionError("候选或项目范围未隔离");
                memories.confirm(Mode.LIFE, life);
                if (memories.context(Mode.LIFE, "", "生活").length() != 1) throw new AssertionError("确认后记忆没有带入");
                memories.update(Mode.LIFE, life, "编辑过的记忆夹具", false);
                if (memories.context(Mode.LIFE, "", "").length() != 0) throw new AssertionError("带上了已停用记忆");
                try { memories.delete(Mode.LIFE, life, true); throw new AssertionError("撤销删除了编辑后的记忆"); }
                catch (IllegalArgumentException expected) {
                    if (!expected.getMessage().contains("已修改")) throw expected;
                }
                memories.delete(Mode.LIFE, life, false);
                try {
                    memories.add(Mode.LIFE, life, "恢复夹具", "explicit", "chat", "[\"home:life\",\"m1\"]", "");
                    throw new AssertionError("删除的记忆被同编号复活");
                } catch (IllegalArgumentException expected) {
                    if (!expected.getMessage().contains("不存在")) throw expected;
                }
                try (Cursor tombstone = database.getReadableDatabase().rawQuery("SELECT deleted, body, source_ref FROM memories WHERE id = ?", new String[]{life})) {
                    if (!tombstone.moveToFirst() || tombstone.getInt(0) != 1 || !tombstone.getString(1).isEmpty() || !tombstone.getString(2).isEmpty())
                        throw new AssertionError("删除没有清除正文与来源");
                }
            }
            return "v1 note preserved; v7 mode and project isolation, memory confirmation, pause, undo boundary and tombstone passed";
        } finally {
            context.deleteDatabase(NAME);
        }
    }
}
