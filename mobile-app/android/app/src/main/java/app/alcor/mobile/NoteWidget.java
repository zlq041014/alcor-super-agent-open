package app.alcor.mobile;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.widget.RemoteViews;

public final class NoteWidget extends AppWidgetProvider {
    @Override public void onUpdate(Context context, AppWidgetManager manager, int[] ids) {
        var capture = PendingIntent.getActivity(context, 0, NoteActivity.launch(context, "widget"), PendingIntent.FLAG_IMMUTABLE);
        var view = new RemoteViews(context.getPackageName(), R.layout.note_widget);
        view.setOnClickPendingIntent(R.id.note_widget_button, capture);
        manager.updateAppWidget(ids, view);
    }
}
