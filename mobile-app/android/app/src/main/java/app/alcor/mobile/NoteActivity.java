package app.alcor.mobile;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;
import app.alcor.mobile.core.Mode;
import app.alcor.mobile.feature.security.AppLock;

public final class NoteActivity extends Activity {
    private static final int PICK = 5913;
    private static final String CAPTURE = "app.alcor.mobile.NOTE";
    private AppContainer container;
    private String id, source;
    private Mode mode;
    private Button modeButton;
    private AppLock appLock;
    private Uri image;
    private EditText body;
    private Button pick, save;
    private TextView error;

    static Intent launch(Context context, String source) {
        return new Intent(context, NoteActivity.class).setAction(CAPTURE).putExtra("source", source);
    }

    @Override @SuppressWarnings("deprecation")
    public void onCreate(Bundle state) {
        super.onCreate(state);
        container = ((AlcorApp) getApplication()).container();
        setContentView(R.layout.note_capture);
        appLock = new AppLock(this, findViewById(R.id.note_root), () -> {});
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            findViewById(R.id.note_root).setOnApplyWindowInsetsListener((view, insets) -> {
                var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
        }
        body = findViewById(R.id.note_body);
        pick = findViewById(R.id.note_picture);
        save = findViewById(R.id.note_save);
        error = findViewById(R.id.note_error);
        findViewById(R.id.note_cancel).setOnClickListener(view -> finish());
        findViewById(R.id.note_clear_picture).setOnClickListener(view -> { image = null; picture(); });
        pick.setOnClickListener(view -> {
            try {
                startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*"), PICK);
            } catch (android.content.ActivityNotFoundException missing) {
                error.setText("没有可用的图片选择器");
            }
        });
        save.setOnClickListener(view -> save());
        Intent intent = getIntent();
        id = state == null ? Notes.newId() : state.getString("id");
        String requested = state == null ? intent.getStringExtra("mode") : state.getString("mode");
        mode = Mode.LIFE.key.equals(requested) ? Mode.LIFE : Mode.WORK.key.equals(requested) ? Mode.WORK : Mode.lastCapture(this);
        modeButton = findViewById(R.id.note_mode);
        modeButton.setText(mode.title);
        modeButton.setOnClickListener(view -> {
            mode = mode == Mode.WORK ? Mode.LIFE : Mode.WORK;
            modeButton.setText(mode.title);
        });
        if (Intent.ACTION_SEND.equals(intent.getAction())) {
            source = "share";
            CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
            if (text == null && intent.getClipData() != null) text = intent.getClipData().getItemAt(0).getText();
            if (text != null) body.setText(text);
            if (text != null && text.length() > Notes.TEXT_LIMIT) {
                body.setText("");
                error.setText("分享的原文超过 16,000 字，请分段复制保存");
            }
            if (intent.getType() != null && intent.getType().startsWith("image/")) {
                Object stream = intent.getParcelableExtra(Intent.EXTRA_STREAM);
                if (stream instanceof Uri) image = (Uri) stream;
                else if (intent.getClipData() != null) image = intent.getClipData().getItemAt(0).getUri();
                if (image == null) error.setText("来源应用没有提供可读的图片");
            }        } else {
            source = switch (String.valueOf(intent.getStringExtra("source"))) {
                case "widget" -> "widget";
                case "shortcut" -> "shortcut";
                default -> "app";
            };
            body.requestFocus();
            getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE |
                WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_VISIBLE);
        }
        if (state != null) image = state.getParcelable("image");
        picture();
    }

    private void picture() {
        pick.setText(image == null ? R.string.note_select_picture : R.string.note_replace_picture);
        findViewById(R.id.note_clear_picture).setVisibility(image == null ? android.view.View.GONE : android.view.View.VISIBLE);
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("id", id);
        state.putString("mode", mode.key);
        state.putParcelable("image", image);
    }

    @Override @SuppressWarnings("deprecation")
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (appLock.onActivityResult(request, result)) return;
        if (request == PICK && result == RESULT_OK && data != null) {
            image = data.getData();
            error.setText("");
            picture();
        }
    }

    private void save() {
        if (appLock.locked()) return;
        String original = body.getText().toString();
        Uri selected = image;
        Mode savingMode = mode;
        save.setEnabled(false);
        modeButton.setEnabled(false);
        pick.setEnabled(false);
        findViewById(R.id.note_clear_picture).setEnabled(false);
        body.setEnabled(false);
        error.setText("");
        container.io().execute(() -> {
            try {
                container.notes().add(savingMode, id, original, selected, source);
                savingMode.rememberCapture(this);
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    Toast.makeText(this, "已记下", Toast.LENGTH_SHORT).show();
                    finish();
                });
            } catch (Exception failure) {
                String reason = failure instanceof IllegalArgumentException || failure instanceof IllegalStateException ?
                    failure.getMessage() : "无法保存笔记，请检查手机存储或重新选图";
                runOnUiThread(() -> {
                    if (isDestroyed()) return;
                    error.setText(reason);
                    save.setEnabled(true);
                    modeButton.setEnabled(true);
                    pick.setEnabled(true);
                    findViewById(R.id.note_clear_picture).setEnabled(true);
                    body.setEnabled(true);
                });
            }
        });
    }

    @Override protected void onStop() {
        appLock.onStop();
        super.onStop();
    }
    @Override protected void onDestroy() {
        appLock.destroy();
        super.onDestroy();
    }
}
