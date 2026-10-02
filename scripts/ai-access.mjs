export function hasAiAccess(profile) {
  return profile?.invite_activated === true;
}

export function requireAiAccess(profile) {
  if (!hasAiAccess(profile)) {
    throw Object.assign(new Error("AI 功能尚未解锁，请在“用户信息”中填写邀请码"), {
      status: 403,
      code: "AI_ACCESS_REQUIRED",
    });
  }
  return profile;
}
