package com.angussoftware.backgroundpoll

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Foreground service that REST-polls a conversation's runs and posts a
 * notification when a run started by another client completes.
 *
 * Everything is native (Kotlin + HttpURLConnection): no JS timers, no
 * long-lived sockets. Each poll opens a fresh connection, so OEM socket
 * reaping for backgrounded apps can't starve it — as long as the process
 * is alive (which the foreground service guarantees), polling works.
 */
class BackgroundPollService : Service() {

  private data class ConversationSpec(val conversationId: String, val agentId: String, val title: String)

  private var scheduler: ScheduledExecutorService? = null
  private val notifiedRunIds: MutableSet<String> = HashSet()
  /** Run id -> first-seen wall clock, for runs whose reply text is still lagging. */
  private val pendingContent = mutableMapOf<String, Long>()
  private var conversations: List<ConversationSpec> = emptyList()
  /** conversationId → spec, for O(1) sweep filtering. */
  private val watched = HashMap<String, ConversationSpec>()
  /** agentId → profile-picture bitmap, fetched once per service lifetime. */
  private val avatarCache = HashMap<String, Bitmap>()
  /** agentId → messaging Person (avatar + name), built once per service lifetime. */
  private val personCache = HashMap<String, Person>()
  private var baseUrl: String = ""
  private var token: String = ""
  private var pollStartedAt: Long = 0L
  private var pollIntervalMs: Long = 20_000L

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null) {
      stopSelf()
      return START_NOT_STICKY
    }
    conversations = parseConversations(intent.getStringExtra("conversations"))
    watched.clear()
    for (c in conversations) watched[c.conversationId] = c
    baseUrl = intent.getStringExtra("baseUrl") ?: "https://api.letta.com"
    token = intent.getStringExtra("token") ?: ""
    pollStartedAt = intent.getLongExtra("pollStartedAt", System.currentTimeMillis())
    pollIntervalMs = intent.getLongExtra("pollIntervalMs", 20_000L)
    // Seed dedup with run IDs the JS stream already notified.
    notifiedRunIds.clear()
    notifiedRunIds.addAll(intent.getStringArrayListExtra("notifiedRunIds") ?: ArrayList())

    if (conversations.isEmpty() || token.isEmpty()) {
      Log.e(TAG, "no conversations or token — stopping")
      stopSelf()
      return START_NOT_STICKY
    }

    startForeground(FGS_NOTIFICATION_ID, buildFgsNotification())
    Log.i(TAG, "polling started convs=${conversations.size} interval=${pollIntervalMs}ms seeded=${notifiedRunIds.size}")

    scheduler?.shutdownNow()
    scheduler = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "bg-run-poll").apply { isDaemon = true }
    }.also {
      it.scheduleWithFixedDelay({ pollOnce() }, 0L, pollIntervalMs, TimeUnit.MILLISECONDS)
    }

    return START_NOT_STICKY
  }

  /** conversations extra: JSON array [{"conversationId":"...","agentId":"...","title":"..."}] */
  private fun parseConversations(json: String?): List<ConversationSpec> {
    if (json.isNullOrEmpty()) return emptyList()
    return try {
      val arr = JSONArray(json)
      (0 until arr.length()).mapNotNull { i ->
        val o = arr.optJSONObject(i) ?: return@mapNotNull null
        val cid = o.optString("conversationId")
        if (cid.isEmpty()) null
        else ConversationSpec(cid, o.optString("agentId"), o.optString("title").ifEmpty { "Conversation" })
      }
    } catch (e: Exception) {
      Log.e(TAG, "bad conversations JSON: ${e.message}")
      emptyList()
    }
  }

  /**
   * Turn-end notification semantics: agentic turns spawn a chain of runs —
   * one user-message run, then one approval run per tool round. Mid-turn
   * approval runs have status "completed" but stop_reason "requires_approval";
   * the run that actually ENDS the turn has stop_reason "end_turn" (or an
   * error/limit reason). Notify only on those turn-boundary runs — one
   * notification per turn, content = the agent's final reply.
   *
   * Cost model: ONE unfiltered /v1/runs sweep per cycle regardless of how
   * many conversations are watched — run objects carry conversation_id, so
   * the watched-set filter is client-side. Polling cost stays flat as the
   * watched set grows.
   */
  private fun pollOnce() {
    var notifications = 0
    try {
      val body = httpGet("$baseUrl/v1/runs?limit=$SWEEP_LIMIT")
      val runs = JSONArray(body) // newest first
      for (i in 0 until runs.length()) {
        val run = runs.optJSONObject(i) ?: continue
        val id = run.optString("id")
        val convId = run.optString("conversation_id")
        if (id.isEmpty() || convId.isEmpty()) continue
        if (convId == visibleConversationId) continue // user is viewing it — the UI already shows it live
        val spec = watched[convId] ?: continue // not a watched conversation
        val status = run.optString("status")
        if (status != "completed" && status != "failed" && status != "cancelled") continue
        val stopReason = run.optString("stop_reason")
        if (stopReason == "requires_approval") continue // mid-turn
        val completedAt = parseIso(run.optString("completed_at"))
        // Only runs finishing after polling began (5s margin for clock skew).
        if (completedAt != null && completedAt < pollStartedAt - 5_000L) continue
        // The user is viewing this conversation — the turn already played out
        // live in front of them. CONSUME the run so it doesn't fire when they
        // leave the screen (the "queued notification" bug).
        if (convId == visibleConversationId) {
          synchronized(notifiedRunIds) { notifiedRunIds.add(id) }
          continue
        }
        val isNew: Boolean
        synchronized(notifiedRunIds) {
          isNew = notifiedRunIds.add(id)
          if (isNew && notifiedRunIds.size > 500) notifiedRunIds.clear()
        }
        if (!isNew) continue
        val reply = findLatestAssistantText(convId, run.optString("created_at"))?.let { truncate(it) }
        val trigger = if (reply != null) null else findUserTrigger(runs, convId)?.let { truncate(it) }
        val content = reply ?: trigger
        if (content == null) {
          // The messages endpoint lags writes: the reply is often not visible
          // yet when the sweep fires seconds after turn end. Defer — retry on
          // the next sweeps before falling back to the generic text.
          val first = pendingContent[id] ?: System.currentTimeMillis().also { pendingContent[id] = it }
          if (System.currentTimeMillis() - first < CONTENT_WAIT_MS && notifications < 3) continue
          pendingContent.remove(id)
        } else {
          pendingContent.remove(id)
        }
        val fallback = if (status == "completed") "Run complete" else "Run ended with an error"
        Log.i(TAG, "turn ended (run ${id.takeLast(8)}, $status/$stopReason) conv=${convId.takeLast(8)} — posting notification")
        postCompletionNotification(spec, content ?: fallback)
        notifications++
        if (notifications >= 3) break // don't storm on catch-up sweeps
      }
    } catch (e: Exception) {
      // Transient network/API errors — retry next cycle.
      Log.w(TAG, "sweep failed: ${e.message}")
    }
    Log.d(TAG, "sweep done ($notifications notified)")
  }

  /**
   * The agent's final reply: newest assistant_message dated at/after the
   * run's start. The messages endpoint returns newest-first; content is a
   * plain string or a content-block array (API shape varies).
   */
  private fun findLatestAssistantText(conversationId: String, runCreatedAtIso: String): String? {
    return try {
      val body = httpGet("$baseUrl/v1/conversations/$conversationId/messages?limit=10")
      val msgs = JSONArray(body)
      val runStart = parseIso(runCreatedAtIso)
      for (i in 0 until msgs.length()) {
        val m = msgs.optJSONObject(i) ?: continue
        if (m.optString("message_type") != "assistant_message") continue
        val date = parseIso(m.optString("date"))
        // Skip replies that predate this run (previous turns).
        if (runStart != null && date != null && date < runStart) continue
        val text = extractContentText(m.opt("content")) ?: continue
        return text
      }
      null
    } catch (e: Exception) {
      Log.w(TAG, "assistant fetch failed conv=${conversationId.takeLast(8)}: ${e.message}")
      null
    }
  }

  /** Walk the run list (newest first, cross-conversation) for the latest
   * user-role initial message in the given conversation. */
  private fun findUserTrigger(runs: JSONArray, conversationId: String): String? {
    for (i in 0 until runs.length()) {
      val run = runs.optJSONObject(i) ?: continue
      if (run.optString("conversation_id") != conversationId) continue
      val msgs = run.optJSONObject("request_config")?.optJSONArray("initial_messages") ?: continue
      if (msgs.length() == 0) continue
      val first = msgs.optJSONObject(0) ?: continue
      if (first.optString("role") != "user") continue
      val text = extractContentText(first.opt("content")) ?: continue
      return text
    }
    return null
  }

  /** Content can be a plain string or a content-block array; skip system-reminder blocks. */
  private fun extractContentText(content: Any?): String? {
    return when (content) {
      is String -> content.takeIf { it.isNotBlank() }
      is JSONArray -> (0 until content.length())
        .mapNotNull { i -> content.optJSONObject(i)?.optString("text")?.takeIf { it.isNotEmpty() } }
        .filterNot { it.startsWith("<system") }
        .joinToString(" ")
        .takeIf { it.isNotBlank() }
      else -> null
    }
  }

  /** Single-line clamp for the notification body. */
  private fun truncate(text: String): String {
    val oneLine = text.replace('\n', ' ').trim()
    return if (oneLine.length <= 120) oneLine else oneLine.take(119) + "…"
  }

  private fun httpGet(url: String): String {
    val conn = URL(url).openConnection() as HttpURLConnection
    try {
      conn.connectTimeout = 10_000
      conn.readTimeout = 15_000
      conn.requestMethod = "GET"
      conn.setRequestProperty("Authorization", "Bearer $token")
      conn.setRequestProperty("Accept", "application/json")
      val code = conn.responseCode
      if (code != 200) {
        throw RuntimeException("HTTP $code")
      }
      return conn.inputStream.bufferedReader().use(BufferedReader::readText)
    } finally {
      conn.disconnect()
    }
  }

  private fun parseIso(iso: String?): Long? {
    if (iso.isNullOrEmpty()) return null
    val fmt = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
    fmt.timeZone = TimeZone.getTimeZone("UTC")
    return try {
      // "2026-08-31T11:52:06.624Z" — truncate fractional seconds + Z.
      val prefix = if (iso.length >= 19) iso.substring(0, 19) else iso
      fmt.parse(prefix)?.time
    } catch (e: Exception) {
      null
    }
  }

  private fun buildFgsNotification(): Notification {
    ensureChannels()
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, FGS_CHANNEL_ID)
        .setContentTitle("Agents Chat")
        .setContentText("Checking for completed runs")
        .setSmallIcon(applicationInfo.icon)
        .setOngoing(true)
        .build()
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
        .setContentTitle("Agents Chat")
        .setContentText("Checking for completed runs")
        .setSmallIcon(applicationInfo.icon)
        .setOngoing(true)
        .build()
    }
  }

  /**
   * The agent's profile picture as a Bitmap, fetched once per agent per
   * service lifetime and cached. Returns null when the agent has no picture
   * or anything fails — the notification then uses the default app icon.
   */
  private fun avatarFor(spec: ConversationSpec): Bitmap? {
    avatarCache[spec.agentId]?.let { return it }
    // Disk cache first — survives app restarts, so the first notification
    // after a reboot already carries the agent picture.
    val disk = loadAvatarFromDisk(spec.agentId)
    if (disk != null) {
      avatarCache[spec.agentId] = disk
      // Refresh from the network in the background; the cached copy renders now.
      scheduler?.submit { fetchAvatarFromNetwork(spec) }
      return disk
    }
    return fetchAvatarFromNetwork(spec)
  }

  private fun avatarFile(agentId: String): File {
    val dir = File(filesDir, "avatars")
    if (!dir.exists()) dir.mkdirs()
    return File(dir, "$agentId.png")
  }

  private fun loadAvatarFromDisk(agentId: String): Bitmap? {
    return try {
      val f = avatarFile(agentId)
      if (!f.exists()) return null
      BitmapFactory.decodeFile(f.absolutePath)
    } catch (e: Exception) {
      null
    }
  }

  private fun fetchAvatarFromNetwork(spec: ConversationSpec): Bitmap? {
    return try {
      val body = httpGet("$baseUrl/v1/agents/${spec.agentId}/profile-picture")
      val dataUrl = JSONObject(body).optString("data_url")
      val b64 = dataUrl.substringAfter("base64,", "")
      if (b64.isEmpty()) return null
      val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
      val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      if (bmp != null) {
        avatarCache[spec.agentId] = bmp
        try {
          java.io.FileOutputStream(avatarFile(spec.agentId)).use { out ->
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
          }
        } catch (e: Exception) {
          Log.w(TAG, "avatar disk write failed: ${e.message}")
        }
        Log.d(TAG, "avatar loaded for agent ${spec.agentId.takeLast(8)} (${bytes.size}B)")
      }
      bmp
    } catch (e: Exception) {
      Log.d(TAG, "no avatar for agent ${spec.agentId.takeLast(8)}: ${e.message}")
      null
    }
  }

  /**
   * The agent as a messaging Person: profile picture when available, else the
   * system's initial-letter avatar. Cached per service lifetime.
   */
  private fun personFor(spec: ConversationSpec): Person {
    personCache[spec.agentId]?.let { return it }
    val builder = Person.Builder().setName(spec.title).setKey(spec.agentId)
    avatarFor(spec)?.let { builder.setIcon(IconCompat.createWithBitmap(it)) }
    return builder.build().also { personCache[spec.agentId] = it }
  }

  /**
   * Conversation channel for the spec: a channel linked (via
   * setConversationId) to a dynamic shortcut carrying the agent avatar.
   * This is the Android 11+ "conversation notification" mechanism — Samsung's
   * shade renders the shortcut's avatar on the collapsed row's left side
   * (like Google Messages), instead of the app launcher icon. Returns the
   * channel id to notify on.
   */
  private fun ensureConversationChannel(spec: ConversationSpec, avatar: Bitmap?): String {
    val channelId = "conv-${spec.conversationId.hashCode()}"
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return CONVERSATIONS_CHANNEL_ID
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(channelId) != null) return channelId

    val deepLink = Uri.parse(
      "agents-chat://chat?conversationId=${spec.conversationId}&agentId=${spec.agentId}&title=${Uri.encode(spec.title)}"
    )
    val intent = Intent(Intent.ACTION_VIEW, deepLink).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val iconRes = resources.getIdentifier("notif_transparent", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    val shortcut = ShortcutInfoCompat.Builder(this, spec.conversationId)
      .setShortLabel(spec.title)
      .setLongLabel(spec.title)
      .setCategories(setOf("android.shortcut.conversation"))
      .setIcon(
        avatar?.let { IconCompat.createWithBitmap(it) }
          ?: IconCompat.createWithResource(this, iconRes)
      )
      .setIntent(intent)
      .setLongLived(true)
      .build()
    try {
      ShortcutManagerCompat.pushDynamicShortcut(this, shortcut)
    } catch (e: Exception) {
      Log.w(TAG, "shortcut push failed conv=${spec.conversationId.takeLast(8)}: ${e.message}")
    }
    val channel = NotificationChannel(channelId, spec.title, NotificationManager.IMPORTANCE_HIGH)
      .apply {
        description = "Run completions for ${spec.title}"
        // parentChannelId = the preexisting "conversations" channel;
        // conversationId = the shortcut id (links the channel to the shortcut).
        setConversationId(CONVERSATIONS_CHANNEL_ID, spec.conversationId)
      }
    try {
      nm.createNotificationChannel(channel)
    } catch (e: Exception) {
      // Samsung validates ordering strictly (parent + shortcut must have
      // settled). The shortcut is now pushed — the next notify succeeds. Until
      // then, fall back to the generic channel so the notification still posts.
      Log.w(TAG, "conversation channel failed: ${e.message}")
      return CONVERSATIONS_CHANNEL_ID
    }
    return channelId
  }

  private fun postCompletionNotification(spec: ConversationSpec, bodyText: String) {
    ensureChannels()
    val deepLink = Uri.parse(
      "agents-chat://chat?conversationId=${spec.conversationId}&agentId=${spec.agentId}&title=${Uri.encode(spec.title)}"
    )
    val intent = Intent(Intent.ACTION_VIEW, deepLink).setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val pending = PendingIntent.getActivity(
      this, spec.conversationId.hashCode(), intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    // Conversation-style notification: Android renders the person's avatar
    // (profile picture, or initial-letter circle without one) on the LEFT —
    // same as SMS/WhatsApp rows. The transparent small icon keeps any
    // leftover app-badge invisible.
    val avatar = avatarFor(spec)
    val channelId = ensureConversationChannel(spec, avatar)
    val person = personFor(spec)
    // One UI's collapsed row renders the LARGE icon as its left-side image;
    // without it the row falls back to the small (app) icon. Set both the
    // person avatar (expanded layout) and the large icon (collapsed row).
    val builder = NotificationCompat.Builder(this, channelId)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
    builder
      .setSmallIcon(
        resources.getIdentifier("notif_transparent", "drawable", packageName)
          .takeIf { it != 0 } ?: applicationInfo.icon
      )
      .setContentIntent(pending)
      .setAutoCancel(true)
      .setShortcutId(spec.conversationId)
      .setLargeIcon(avatar)
      .setStyle(
        NotificationCompat.MessagingStyle(person)
          .addMessage(bodyText, System.currentTimeMillis(), person)
      )
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    nm.notify(spec.conversationId.hashCode(), builder.build())
  }

  private fun ensureChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
    // High-importance alert channel — matches the JS-side poster's channel id.
    if (nm.getNotificationChannel(CONVERSATIONS_CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CONVERSATIONS_CHANNEL_ID, "Conversation activity", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "Run completions and agent activity" }
      )
    }
    // Silent persistent channel for the foreground-service notification.
    if (nm.getNotificationChannel(FGS_CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          FGS_CHANNEL_ID, "Background polling", NotificationManager.IMPORTANCE_MIN
        ).apply { description = "Keeps run-completion checks running while backgrounded" }
      )
    }
  }

  override fun onDestroy() {
    scheduler?.shutdownNow()
    scheduler = null
    Log.i(TAG, "polling stopped")
    super.onDestroy()
  }

  companion object {
    const val TAG = "BG-POLL"
    /** How long a completed run may wait for lagging reply text before the generic fallback posts. */
    const val CONTENT_WAIT_MS = 30_000L
    /** The conversation currently on screen — notifications for it are suppressed. */
    @Volatile
    var visibleConversationId: String? = null
    const val FGS_NOTIFICATION_ID = 93001
    const val FGS_CHANNEL_ID = "background_polling"
    const val CONVERSATIONS_CHANNEL_ID = "conversations"
    /** Runs fetched per sweep — one request covers every watched conversation. */
    const val SWEEP_LIMIT = 50
  }
}
