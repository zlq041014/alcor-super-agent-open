package app.alcor.mobile.bridge;

import org.json.JSONObject;
import app.alcor.mobile.core.Mode;

public interface Host {
    boolean locked();
    void privacy(String id, String op, JSONObject input) throws Exception;
    /** Native chat snapshot; a leading ~ means the caller should fall back to readState/saveState. */
    String loadState();

    /** Returns an empty string on success, otherwise a user-facing reason. */
    String commitState(String json);

    String readState();

    String saveState(String json);

    boolean online();

    void result(String id, String type, Object data);

    void pick(String dialog, boolean photos);

    JSONObject preview(String dialog, String ref) throws Exception;

    void capture(String source, Mode mode);

    void notePreview(Mode mode, String id) throws Exception;
    void reminderPermission(String setting);
    JSONObject openedReminder();
    String openedWorkNotice();
    void workNoticeSettings();

    void event(String type, JSONObject data);

    void export(String id, JSONObject input, boolean png) throws Exception;

    void copy(String text);

    void browse(String value);
}
