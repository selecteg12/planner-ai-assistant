const SESSION_TTL_DAYS = 30;

function throwIfError(error, operation) {
  if (error) {
    const wrapped = new Error(`Telegram session ${operation} failed`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function createSupabaseSessionStore({ supabase, now = () => new Date() }) {
  if (!supabase) throw new TypeError("A Supabase client is required for persistent Telegram sessions");

  return {
    async get(sessionKey) {
      const { data, error } = await supabase
        .from("telegram_sessions")
        .select("session_data, expires_at")
        .eq("session_key", sessionKey)
        .maybeSingle();
      throwIfError(error, "lookup");
      if (!data) return undefined;
      if (Date.parse(data.expires_at) <= now().getTime()) {
        await this.delete(sessionKey);
        return undefined;
      }
      return data.session_data;
    },

    async set(sessionKey, sessionData) {
      if (typeof sessionKey !== "string" || !/^-?\d+:-?\d+$/.test(sessionKey)) {
        throw new TypeError("Telegram session key is invalid");
      }
      const expiresAt = new Date(now().getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      const { error } = await supabase
        .from("telegram_sessions")
        .upsert({
          session_key: sessionKey,
          session_data: sessionData,
          expires_at: expiresAt.toISOString(),
          updated_at: now().toISOString(),
        }, { onConflict: "session_key" });
      throwIfError(error, "save");
    },

    async delete(sessionKey) {
      const { error } = await supabase
        .from("telegram_sessions")
        .delete()
        .eq("session_key", sessionKey);
      throwIfError(error, "delete");
    },
  };
}

module.exports = { createSupabaseSessionStore, SESSION_TTL_DAYS };
