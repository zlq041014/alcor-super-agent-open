package app.alcor.mobile;

import android.content.Context;
import app.alcor.mobile.core.db.Database;
import app.alcor.mobile.feature.chat.ChatStore;
import app.alcor.mobile.feature.reminders.Reminders;
import app.alcor.mobile.feature.memory.Memories;
import app.alcor.mobile.feature.work.WorkNotices;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** One long-lived set of app-wide dependencies. */
final class AppContainer {
    private final Context context;
    private final Database database;
    private final SecretStore secrets;
    private final ModelTurns modelTurns = new ModelTurns();
    private final DiscussionFiles materials;
    private final IncomingFiles incoming;
    private final Notes notes;
    private final ChatStore chat;
    private final MarkdownFiles markdown;
    private final Reminders reminders;
    private final Memories memories;
    private final WorkNotices workNotices;
    private final LocalBackup backup;
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final ExecutorService receiver = Executors.newSingleThreadExecutor();

    AppContainer(Context context) {
        this.context = context.getApplicationContext();
        database = new Database(this.context);
        secrets = new SecretStore(this.context);
        materials = new DiscussionFiles(this.context);
        incoming = new IncomingFiles(this.context, materials);
        notes = new Notes(this.context, database, materials);
        chat = new ChatStore(database, new File(this.context.getFilesDir(), "discussions.json"));
        markdown = new MarkdownFiles(this.context);
        reminders = new Reminders(this.context, database);
        memories = new Memories(database);
        backup = new LocalBackup(this.context, database, chat, materials);
        workNotices = new WorkNotices(this.context, database);
    }

    Context context() {
        return context;
    }

    SecretStore secrets() {
        return secrets;
    }

    ModelTurns modelTurns() { return modelTurns; }

    DiscussionFiles materials() {
        return materials;
    }

    IncomingFiles incoming() {
        return incoming;
    }

    Notes notes() {
        return notes;
    }

    ChatStore chat() {
        return chat;
    }

    MarkdownFiles markdown() {
        return markdown;
    }

    Reminders reminders() { return reminders; }
    Memories memories() { return memories; }
    LocalBackup backup() { return backup; }
    WorkNotices workNotices() { return workNotices; }

    ExecutorService io() {
        return io;
    }

    ExecutorService receiver() {
        return receiver;
    }
}
