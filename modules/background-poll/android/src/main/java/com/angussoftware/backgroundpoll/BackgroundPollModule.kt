package com.angussoftware.backgroundpoll

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * JS bridge for the native background run-completion poller.
 *
 * Why native: JS timers (setTimeout/setInterval) never fire in backgrounded
 * RN contexts — the main context pauses timers on host pause, and headless
 * task contexts (react-native-background-actions) don't drive them at all on
 * the bridgeless runtime. Polling in Kotlin with its own foreground service
 * is immune to both.
 */
class BackgroundPollModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackgroundPoll")

    AsyncFunction("startPolling") { options: Map<String, Any?> ->
      val context = appContext.reactContext
        ?: throw IllegalStateException("No React context available")
      val intent = Intent(context, BackgroundPollService::class.java).apply {
        putExtra("conversations", options["conversations"] as? String ?: "[]")
        putExtra("baseUrl", options["baseUrl"] as? String ?: "https://api.letta.com")
        putExtra("token", options["token"] as? String ?: "")
        putExtra("pollStartedAt", (options["pollStartedAt"] as? Number)?.toLong() ?: System.currentTimeMillis())
        val notified = (options["notifiedRunIds"] as? List<*>)?.filterIsInstance<String>() ?: emptyList()
        putStringArrayListExtra("notifiedRunIds", ArrayList(notified))
        putExtra("pollIntervalMs", (options["pollIntervalMs"] as? Number)?.toLong() ?: 20_000L)
      }
      // Replace any previous polling instance.
      context.stopService(Intent(context, BackgroundPollService::class.java))
      context.startForegroundService(intent)
    }

    AsyncFunction("setVisibleConversation") { conversationId: String? ->
      BackgroundPollService.reportVisibleConversation(conversationId)
    }

    AsyncFunction("stopPolling") {
      val context = appContext.reactContext
      context?.stopService(Intent(context, BackgroundPollService::class.java))
    }
  }
}
