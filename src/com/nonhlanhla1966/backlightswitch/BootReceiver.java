package com.nonhlanhla1966.backlightswitch;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Restores per-app auto brightness after a reboot when it was enabled. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) return;
        if (!MainActivity.prefs(context).getBoolean(MainActivity.KEY_AUTO, false)) return;
        try {
            context.startForegroundService(
                    new Intent(context, BrightnessWatcherService.class));
        } catch (Exception ignored) {}
    }
}
