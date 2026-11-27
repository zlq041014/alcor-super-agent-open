package app.alcor.mobile.wxapi;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import app.alcor.mobile.MainActivity;
import app.alcor.mobile.R;
import com.tencent.mm.opensdk.modelbase.BaseReq;
import com.tencent.mm.opensdk.modelbase.BaseResp;
import com.tencent.mm.opensdk.modelbiz.WXLaunchMiniProgram;
import com.tencent.mm.opensdk.modelmsg.ShowMessageFromWX;
import com.tencent.mm.opensdk.openapi.IWXAPIEventHandler;
import com.tencent.mm.opensdk.openapi.WXAPIFactory;

public final class WXEntryActivity extends Activity implements IWXAPIEventHandler {
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        var api = WXAPIFactory.createWXAPI(this, getString(R.string.wechat_app_id), true);
        try { api.handleIntent(getIntent(), this); }
        finally { api.detach(); finish(); }
    }
    private void resumeDiscussion() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
    }
    @Override public void onReq(BaseReq req) { if (req instanceof ShowMessageFromWX.Req) resumeDiscussion(); }
    @Override public void onResp(BaseResp resp) { if (resp instanceof WXLaunchMiniProgram.Resp) resumeDiscussion(); }
}
