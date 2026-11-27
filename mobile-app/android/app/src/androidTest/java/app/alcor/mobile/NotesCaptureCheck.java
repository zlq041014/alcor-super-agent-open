package app.alcor.mobile;

import android.content.Context;
import android.content.ContextWrapper;
import android.database.sqlite.SQLiteConstraintException;
import android.graphics.Bitmap;
import android.graphics.Color;
import androidx.core.content.FileProvider;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.core.db.Database;
import java.io.File;
import java.nio.file.Files;
import java.util.Arrays;

final class NotesCaptureCheck {
    static String run(Context context) throws Exception {
        String id = Notes.newId(), foreign = Notes.newId(), failed = Notes.newId(), removed = Notes.newId(), partial = Notes.newId();
        File storage = new File(context.getCacheDir(), "notes-storage-" + id);
        var files = new DiscussionFiles(new ContextWrapper(context) {
            @Override public File getFilesDir() { return storage; }
        });
        File fixture = new File(context.getFilesDir(), "wechat-files/notes-capture-" + id + ".png");
        Files.createDirectories(fixture.getParentFile().toPath());
        var image = FileProvider.getUriForFile(context, context.getPackageName() + ".materials", fixture);
        String dbName = "notes-capture-" + id + ".db";
        try (var database = new Database(context, dbName)) {
            var notes = new Notes(context, database, files);
            pixel(fixture, Color.RED);
            files.restoreBackupFile(id, "note:" + id, fixture, "before.png", "image/png");
            files.restoreBackupFile(foreign, "discussion:fixture", fixture, "other.png", "image/png");
            if (notes.inboxCount(Mode.WORK) != 0) throw new AssertionError("只写入媒体的中断状态出现了笔记");
            byte[] previous = Files.readAllBytes(fixture.toPath());
            pixel(fixture, Color.BLUE);
            byte[] replacement = Files.readAllBytes(fixture.toPath());
            notes.add(Mode.WORK, id, "新选图片", image, "share");
            pixel(fixture, Color.GREEN);
            notes.add(Mode.WORK, id, "不应覆盖", image, "share");
            if (notes.inboxCount(Mode.WORK) != 1 || !"新选图片".equals(notes.get(Mode.WORK, id).getString("text")) ||
                !Arrays.equals(replacement, Files.readAllBytes(files.backupFile("note:" + id, id + ":0").toPath())))
                throw new AssertionError("重试没有替换中断图片，或保存后被再次覆盖");
            try {
                notes.add(Mode.WORK, foreign, "不能覆盖其他材料", image, "share");
                throw new AssertionError("覆盖了其他讨论的附件");
            } catch (IllegalStateException expected) {
                if (!Arrays.equals(previous, Files.readAllBytes(files.backupFile("discussion:fixture", foreign + ":0").toPath())))
                    throw new AssertionError("拒绝后其他附件发生变化", expected);
            }
            var sql = database.getWritableDatabase();
            sql.execSQL("CREATE TRIGGER reject_capture BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'fixture rejected'); END");
            try {
                notes.add(Mode.WORK, failed, "写入失败样本", image, "share");
                throw new AssertionError("预期 SQLite 拒绝写入");
            } catch (SQLiteConstraintException expected) {
                if (files.directory(failed).exists() || notes.inboxCount(Mode.WORK) != 1)
                    throw new AssertionError("写入失败留下了部分数据", expected);
            }
            sql.execSQL("DROP TRIGGER reject_capture");
            notes.add(Mode.WORK, failed, "失败后重试", image, "share");
            if (notes.inboxCount(Mode.WORK) != 2) throw new AssertionError("失败后没有成功重试");
            files.restoreBackupFile(removed, "note:" + removed, fixture, "removed.png", "image/png");
            notes.addText(Mode.WORK, removed, "去掉图片后重试", "share");
            if (files.directory(removed).exists() || notes.get(Mode.WORK, removed).getBoolean("image"))
                throw new AssertionError("移除图片后还保留了中断的副本");
            files.beginNoteImage(partial);
            Files.createDirectory(files.directory(partial).toPath());
            Files.write(new File(files.directory(partial), "0.new").toPath(), new byte[]{1, 2, 3});
            files.beginNoteImage(id); // Commit succeeded, but the process did not remove the marker.
            var reopened = new Notes(context, database, files);
            reopened.list(Mode.WORK, "", 0, "");
            if (files.directory(partial).exists() || files.pendingNoteImages().contains(partial) ||
                files.pendingNoteImages().contains(id) || !Arrays.equals(replacement,
                    Files.readAllBytes(files.backupFile("note:" + id, id + ":0").toPath())))
                throw new AssertionError("恢复没有清理中断副本，或误删了已提交的图片");
            return "uncommitted copy removed after restart; committed image intact; idempotent retry and insert rollback";
        } finally {
            Files.deleteIfExists(fixture.toPath());
            context.deleteDatabase(dbName);
            for (String batch : new String[]{id, foreign, failed, removed, partial}) {
                files.discard(batch);
                files.finishNoteImage(batch);
            }
            Files.deleteIfExists(new File(storage, "wechat-files").toPath());
            Files.deleteIfExists(new File(storage, "note-image-pending").toPath());
            Files.deleteIfExists(storage.toPath());
        }
    }

    private static void pixel(File target, int color) throws Exception {
        var bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888);
        try (var stream = Files.newOutputStream(target.toPath())) {
            bitmap.eraseColor(color);
            if (!bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream))
                throw new java.io.IOException("无法写入测试图片");
        } finally { bitmap.recycle(); }
    }
}
