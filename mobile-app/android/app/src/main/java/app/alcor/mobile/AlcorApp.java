package app.alcor.mobile;

import android.app.Application;

public final class AlcorApp extends Application {
    private AppContainer container;

    @Override public void onCreate() {
        super.onCreate();
        container = new AppContainer(this);
    }

    AppContainer container() {
        return container;
    }
}
