/**
 * QQ Bot API 鉴权和请求封装
 */

import { SocksProxyAgent } from "socks-proxy-agent";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

// 运行时配置
let currentMarkdownSupport = false;

/**
 * 初始化 API 配置
 * @param options.markdownSupport - 是否支持 markdown 消息（默认 false，需要机器人具备该权限才能启用）
 */
export function initApiConfig(options: { markdownSupport?: boolean }): void {
  currentMarkdownSupport = options.markdownSupport === true; // 默认为 false，需要机器人具备 markdown 消息权限才能启用
}

/**
 * 获取当前是否支持 markdown
 */
export function isMarkdownSupport(): boolean {
  return currentMarkdownSupport;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
// Singleflight: 防止并发获取 Token 的 Promise 缓存
let tokenFetchPromise: Promise<string> | null = null;

/**
 * 获取 AccessToken（带缓存 + singleflight 并发安全）
 * 
 * 使用 singleflight 模式：当多个请求同时发现 Token 过期时，
 * 只有第一个请求会真正去获取新 Token，其他请求复用同一个 Promise。
 */
export async function getAccessToken(appId: string, clientSecret: string, proxyUrl?: string): Promise<string> {
  // 检查缓存，提前 5 分钟刷新
  if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) {
    return cachedToken.token;
  }

  // Singleflight: 如果已有进行中的 Token 获取请求，复用它
  if (tokenFetchPromise) {
    console.log(`[qqbot-api] Token fetch in progress, waiting for existing request...`);
    return tokenFetchPromise;
  }

  // 创建新的 Token 获取 Promise（singleflight 入口）
  tokenFetchPromise = (async () => {
    try {
      return await doFetchToken(appId, clientSecret, proxyUrl);
    } finally {
      // 无论成功失败，都清除 Promise 缓存
      tokenFetchPromise = null;
    }
  })();

  return tokenFetchPromise;
}

/**
 * 实际执行 Token 获取的内部函数
 */
async function doFetchToken(appId: string, clientSecret: string, proxyUrl?: string): Promise<string> {

  const requestBody = { appId, clientSecret };
  const requestHeaders = { "Content-Type": "application/json" };

  // 打印请求信息（隐藏敏感信息）
  console.log(`[qqbot-api] >>> POST ${TOKEN_URL}`);
  console.log(`[qqbot-api] >>> Headers:`, JSON.stringify(requestHeaders, null, 2));
  console.log(`[qqbot-api] >>> Body:`, JSON.stringify({ appId, clientSecret: "***" }, null, 2));

  // 使用 https.request 以支持 SOCKS5 代理
  const https = await import("node:https");
  const { URL } = await import("node:url");

  const parsedUrl = new URL(TOKEN_URL);
  const agent = proxyUrl && proxyUrl.startsWith("socks") ? new SocksProxyAgent(proxyUrl) : undefined;

  const options: any = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method: "POST",
    headers: requestHeaders,
    ...(agent ? { agent } : {}),
  };

  let response: any;
  let rawBody: string = "";

  try {
    response = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.on("data", (chunk) => { rawBody += chunk.toString(); });
        res.on("end", () => resolve(res));
        res.on("error", reject);
      });
      req.on("error", reject);
      req.write(JSON.stringify(requestBody));
      req.end();
    });
  } catch (err) {
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error getting access_token: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = response.headers || {};
  console.log(`[qqbot-api] <<< Status: ${response.statusCode} ${response.statusMessage}`);
  console.log(`[qqbot-api] <<< Headers:`, JSON.stringify(responseHeaders, null, 2));

  let data: { access_token?: string; expires_in?: number };
  try {
    // 隐藏 token 值
    const logBody = rawBody.replace(/"access_token"\s*:\s*"[^"]+"/g, '"access_token": "***"');
    console.log(`[qqbot-api] <<< Body:`, logBody);
    data = JSON.parse(rawBody) as { access_token?: string; expires_in?: number };
  } catch (err) {
    console.error(`[qqbot-api] <<< Parse error:`, err);
    throw new Error(`Failed to parse access_token response: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!data.access_token) {
    throw new Error(`Failed to get access_token: ${JSON.stringify(data)}`);
  }

  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
  };

  console.log(`[qqbot-api] Token cached, expires at: ${new Date(cachedToken.expiresAt).toISOString()}`);
  return cachedToken.token;
}

/**
 * 清除 Token 缓存
 */
export function clearTokenCache(): void {
  cachedToken = null;
  // 注意：不清除 tokenFetchPromise，让进行中的请求完成
  // 下次调用 getAccessToken 时会自动获取新 Token
}

/**
 * 获取 Token 缓存状态（用于监控）
 */
export function getTokenStatus(): { status: "valid" | "expired" | "refreshing" | "none"; expiresAt: number | null } {
  if (tokenFetchPromise) {
    return { status: "refreshing", expiresAt: cachedToken?.expiresAt ?? null };
  }
  if (!cachedToken) {
    return { status: "none", expiresAt: null };
  }
  const isValid = Date.now() < cachedToken.expiresAt - 5 * 60 * 1000;
  return { status: isValid ? "valid" : "expired", expiresAt: cachedToken.expiresAt };
}

/**
 * msg_seq 追踪器 - 用于对同一条消息的多次回复
 * key: msg_id, value: 当前 seq 值
 * 使用时间戳作为基础值，确保进程重启后不会重复
 */
const msgSeqTracker = new Map<string, number>();
const seqBaseTime = Math.floor(Date.now() / 1000) % 100000000; // 取秒级时间戳的后8位作为基础

/**
 * 获取并递增消息序号
 * 返回的 seq 会基于时间戳，避免进程重启后重复
 */
export function getNextMsgSeq(msgId: string): number {
  const current = msgSeqTracker.get(msgId) ?? 0;
  const next = current + 1;
  msgSeqTracker.set(msgId, next);

  // 清理过期的序号
  // 简单策略：保留最近 1000 条
  if (msgSeqTracker.size > 1000) {
    const keys = Array.from(msgSeqTracker.keys());
    for (let i = 0; i < 500; i++) {
      msgSeqTracker.delete(keys[i]);
    }
  }

  // 结合时间戳基础值，确保唯一性
  return seqBaseTime + next;
}

/**
 * API 请求封装
 */
export async function apiRequest<T = unknown>(
  accessToken: string,
  method: string,
  path: string,
  body?: unknown,
  proxyUrl?: string
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${accessToken}`,
    "Content-Type": "application/json",
  };

  // DEBUG: 打印代理信息
  if (proxyUrl) {
    console.log(`[qqbot-api] 🔧 Using proxy: ${proxyUrl}`);
  } else {
    console.log(`[qqbot-api] ⚠️  No proxy configured for this request`);
  }

  // 打印请求信息
  console.log(`[qqbot-api] >>> ${method} ${url}`);
  console.log(`[qqbot-api] >>> Headers:`, JSON.stringify(headers, null, 2));
  if (body) {
    console.log(`[qqbot-api] >>> Body:`, JSON.stringify(body, null, 2));
  }

  // 使用 https.request 以支持 SOCKS5 代理
  const https = await import("node:https");
  const { URL } = await import("node:url");

  const parsedUrl = new URL(url);
  const agent = proxyUrl && proxyUrl.startsWith("socks") ? new SocksProxyAgent(proxyUrl) : undefined;

  const options: any = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || 443,
    path: parsedUrl.pathname + parsedUrl.search,
    method,
    headers,
    ...(agent ? { agent } : {}),
  };

  let response: any;
  let rawBody: string = "";

  try {
    response = await new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        res.on("data", (chunk) => { rawBody += chunk.toString(); });
        res.on("end", () => resolve(res));
        res.on("error", reject);
      });
      req.on("error", reject);
      if (body) {
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  } catch (err) {
    console.error(`[qqbot-api] <<< Network error:`, err);
    throw new Error(`Network error [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 打印响应头
  const responseHeaders: Record<string, string> = response.headers || {};
  console.log(`[qqbot-api] <<< Status: ${response.statusCode} ${response.statusMessage}`);
  console.log(`[qqbot-api] <<< Headers:`, JSON.stringify(responseHeaders, null, 2));

  let data: T;
  try {
    console.log(`[qqbot-api] <<< Body:`, rawBody);
    data = JSON.parse(rawBody) as T;
  } catch (err) {
    console.error(`[qqbot-api] <<< Parse error:`, err);
    throw new Error(`Failed to parse response [${path}]: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
    const error = data as { message?: string; code?: number };
    throw new Error(`API Error [${path}]: ${error.message ?? JSON.stringify(data)}`);
  }

  return data;
}

/**
 * 获取 WebSocket Gateway URL
 */
export async function getGatewayUrl(accessToken: string, proxyUrl?: string): Promise<string> {
  const data = await apiRequest<{ url: string }>(accessToken, "GET", "/gateway", undefined, proxyUrl);
  return data.url;
}

// ============ 消息发送接口 ============

/**
 * 消息响应
 */
export interface MessageResponse {
  id: string;
  timestamp: number | string;
}

/**
 * 构建消息体
 * 根据 markdownSupport 配置决定消息格式：
 * - markdown 模式: { markdown: { content }, msg_type: 2 }
 * - 纯文本模式: { content, msg_type: 0 }
 */
function buildMessageBody(
  content: string,
  msgId: string | undefined,
  msgSeq: number
): Record<string, unknown> {
  const body: Record<string, unknown> = currentMarkdownSupport
    ? {
      markdown: { content },
      msg_type: 2,
      msg_seq: msgSeq,
    }
    : {
      content,
      msg_type: 0,
      msg_seq: msgSeq,
    };

  if (msgId) {
    body.msg_id = msgId;
  }

  return body;
}

/**
 * 发送 C2C 单聊消息
 */
export async function sendC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  msgId?: string,
  proxyUrl?: string
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq);

  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body, proxyUrl);
}

/**
 * 发送 C2C 输入状态提示（告知用户机器人正在输入）
 */
export async function sendC2CInputNotify(
  accessToken: string,
  openid: string,
  msgId?: string,
  inputSecond: number = 60,
  proxyUrl?: string
): Promise<void> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = {
    msg_type: 6,
    input_notify: {
      input_type: 1,
      input_second: inputSecond,
    },
    msg_seq: msgSeq,
    ...(msgId ? { msg_id: msgId } : {}),
  };

  await apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body, proxyUrl);
}

/**
 * 发送频道消息（不支持流式）
 */
export async function sendChannelMessage(
  accessToken: string,
  channelId: string,
  content: string,
  msgId?: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: string }> {
  return apiRequest(accessToken, "POST", `/channels/${channelId}/messages`, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  }, proxyUrl);
}

/**
 * 发送群聊消息
 */
export async function sendGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  msgId?: string,
  proxyUrl?: string
): Promise<MessageResponse> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  const body = buildMessageBody(content, msgId, msgSeq);

  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, proxyUrl);
}

/**
 * 构建主动消息请求体
 * 根据 markdownSupport 配置决定消息格式：
 * - markdown 模式: { markdown: { content }, msg_type: 2 }
 * - 纯文本模式: { content, msg_type: 0 }
 * 
 * 注意：主动消息不支持流式发送
 */
function buildProactiveMessageBody(content: string): Record<string, unknown> {
  // 主动消息内容校验（参考 Telegram 机制）
  if (!content || content.trim().length === 0) {
    throw new Error("主动消息内容不能为空 (markdown.content is empty)");
  }

  if (currentMarkdownSupport) {
    return {
      markdown: { content },
      msg_type: 2,
    };
  } else {
    return {
      content,
      msg_type: 0,
    };
  }
}

/**
 * 主动发送 C2C 单聊消息（不需要 msg_id，每月限 4 条/用户）
 * 
 * 注意：
 * 1. 内容不能为空（对应 markdown.content 字段）
 * 2. 不支持流式发送
 */
export async function sendProactiveC2CMessage(
  accessToken: string,
  openid: string,
  content: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: number }> {
  const body = buildProactiveMessageBody(content);
  console.log(`[qqbot-api] sendProactiveC2CMessage: openid=${openid}, msg_type=${body.msg_type}, content_len=${content.length}`);
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, body, proxyUrl);
}

/**
 * 主动发送群聊消息（不需要 msg_id，每月限 4 条/群）
 * 
 * 注意：
 * 1. 内容不能为空（对应 markdown.content 字段）
 * 2. 不支持流式发送
 */
export async function sendProactiveGroupMessage(
  accessToken: string,
  groupOpenid: string,
  content: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: string }> {
  const body = buildProactiveMessageBody(content);
  console.log(`[qqbot-api] sendProactiveGroupMessage: group=${groupOpenid}, msg_type=${body.msg_type}, content_len=${content.length}`);
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, body, proxyUrl);
}

// ============ 富媒体消息支持 ============

/**
 * 媒体文件类型
 */
export enum MediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4, // 暂未开放
}

/**
 * 上传富媒体文件的响应
 */
export interface UploadMediaResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
  id?: string; // 仅当 srv_send_msg=true 时返回
}

/**
 * 上传富媒体文件到 C2C 单聊
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 */
export async function uploadC2CMedia(
  accessToken: string,
  openid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  proxyUrl?: string
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadC2CMedia: url or fileData is required");
  }

  const body: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: srvSendMsg,
  };

  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }

  return apiRequest(accessToken, "POST", `/v2/users/${openid}/files`, body, proxyUrl);
}

/**
 * 上传富媒体文件到群聊
 * @param url - 公网可访问的图片 URL（与 fileData 二选一）
 * @param fileData - Base64 编码的文件内容（与 url 二选一）
 */
export async function uploadGroupMedia(
  accessToken: string,
  groupOpenid: string,
  fileType: MediaFileType,
  url?: string,
  fileData?: string,
  srvSendMsg = false,
  proxyUrl?: string
): Promise<UploadMediaResponse> {
  if (!url && !fileData) {
    throw new Error("uploadGroupMedia: url or fileData is required");
  }

  const body: Record<string, unknown> = {
    file_type: fileType,
    srv_send_msg: srvSendMsg,
  };

  if (url) {
    body.url = url;
  } else if (fileData) {
    body.file_data = fileData;
  }

  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/files`, body, proxyUrl);
}

/**
 * 发送 C2C 单聊富媒体消息
 */
export async function sendC2CMediaMessage(
  accessToken: string,
  openid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: number }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/users/${openid}/messages`, {
    msg_type: 7, // 富媒体消息类型
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  }, proxyUrl);
}

/**
 * 发送群聊富媒体消息
 */
export async function sendGroupMediaMessage(
  accessToken: string,
  groupOpenid: string,
  fileInfo: string,
  msgId?: string,
  content?: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: string }> {
  const msgSeq = msgId ? getNextMsgSeq(msgId) : 1;
  return apiRequest(accessToken, "POST", `/v2/groups/${groupOpenid}/messages`, {
    msg_type: 7, // 富媒体消息类型
    media: { file_info: fileInfo },
    msg_seq: msgSeq,
    ...(content ? { content } : {}),
    ...(msgId ? { msg_id: msgId } : {}),
  }, proxyUrl);
}

/**
 * 发送带图片的 C2C 单聊消息（封装上传+发送）
 * @param imageUrl - 图片来源，支持：
 *   - 公网 URL: https://example.com/image.png
 *   - Base64 Data URL: data:image/png;base64,xxxxx
 */
export async function sendC2CImageMessage(
  accessToken: string,
  openid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: number }> {
  let uploadResult: UploadMediaResponse;

  // 检查是否是 Base64 Data URL
  if (imageUrl.startsWith("data:")) {
    // 解析 Base64 Data URL: data:image/png;base64,xxxxx
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    const base64Data = matches[2];
    // 使用 file_data 上传
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, undefined, base64Data, false, proxyUrl);
  } else {
    // 公网 URL，使用 url 参数上传
    uploadResult = await uploadC2CMedia(accessToken, openid, MediaFileType.IMAGE, imageUrl, undefined, false, proxyUrl);
  }

  // 发送富媒体消息
  return sendC2CMediaMessage(accessToken, openid, uploadResult.file_info, msgId, content, proxyUrl);
}

/**
 * 发送带图片的群聊消息（封装上传+发送）
 * @param imageUrl - 图片来源，支持：
 *   - 公网 URL: https://example.com/image.png
 *   - Base64 Data URL: data:image/png;base64,xxxxx
 */
export async function sendGroupImageMessage(
  accessToken: string,
  groupOpenid: string,
  imageUrl: string,
  msgId?: string,
  content?: string,
  proxyUrl?: string
): Promise<{ id: string; timestamp: string }> {
  let uploadResult: UploadMediaResponse;

  // 检查是否是 Base64 Data URL
  if (imageUrl.startsWith("data:")) {
    // 解析 Base64 Data URL: data:image/png;base64,xxxxx
    const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) {
      throw new Error("Invalid Base64 Data URL format");
    }
    const base64Data = matches[2];
    // 使用 file_data 上传
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, undefined, base64Data, false, proxyUrl);
  } else {
    // 公网 URL，使用 url 参数上传
    uploadResult = await uploadGroupMedia(accessToken, groupOpenid, MediaFileType.IMAGE, imageUrl, undefined, false, proxyUrl);
  }

  // 发送富媒体消息
  return sendGroupMediaMessage(accessToken, groupOpenid, uploadResult.file_info, msgId, content, proxyUrl);
}

// ============ 后台 Token 刷新 (P1-1) ============

/**
 * 后台 Token 刷新配置
 */
interface BackgroundTokenRefreshOptions {
  /** 提前刷新时间（毫秒，默认 5 分钟） */
  refreshAheadMs?: number;
  /** 随机偏移范围（毫秒，默认 0-30 秒） */
  randomOffsetMs?: number;
  /** 最小刷新间隔（毫秒，默认 1 分钟） */
  minRefreshIntervalMs?: number;
  /** 失败后重试间隔（毫秒，默认 5 秒） */
  retryDelayMs?: number;
  /** 日志函数 */
  log?: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  };
}

// 后台刷新状态
let backgroundRefreshRunning = false;
let backgroundRefreshAbortController: AbortController | null = null;

/**
 * 启动后台 Token 刷新
 * 在后台定时刷新 Token，避免请求时才发现过期
 * 
 * @param appId 应用 ID
 * @param clientSecret 应用密钥
 * @param proxyUrl SOCKS5 代理 URL（可选）
 * @param options 配置选项
 */
export function startBackgroundTokenRefresh(
  appId: string,
  clientSecret: string,
  proxyUrl?: string,
  options?: BackgroundTokenRefreshOptions
): void {
  if (backgroundRefreshRunning) {
    console.log("[qqbot-api] Background token refresh already running");
    return;
  }

  const {
    refreshAheadMs = 5 * 60 * 1000, // 提前 5 分钟刷新
    randomOffsetMs = 30 * 1000, // 0-30 秒随机偏移
    minRefreshIntervalMs = 60 * 1000, // 最少 1 分钟后刷新
    retryDelayMs = 5 * 1000, // 失败后 5 秒重试
    log,
  } = options ?? {};

  backgroundRefreshRunning = true;
  backgroundRefreshAbortController = new AbortController();
  const signal = backgroundRefreshAbortController.signal;

  const refreshLoop = async () => {
    log?.info?.("[qqbot-api] Background token refresh started");

    while (!signal.aborted) {
      try {
        // 先确保有一个有效 Token（传递 proxyUrl）
        await getAccessToken(appId, clientSecret, proxyUrl);

        // 计算下次刷新时间
        if (cachedToken) {
          const expiresIn = cachedToken.expiresAt - Date.now();
          // 提前刷新时间 + 随机偏移（避免集群同时刷新）
          const randomOffset = Math.random() * randomOffsetMs;
          const refreshIn = Math.max(
            expiresIn - refreshAheadMs - randomOffset,
            minRefreshIntervalMs
          );

          log?.debug?.(
            `[qqbot-api] Token valid, next refresh in ${Math.round(refreshIn / 1000)}s`
          );

          // 等待到刷新时间
          await sleep(refreshIn, signal);
        } else {
          // 没有缓存的 Token，等待一段时间后重试
          log?.debug?.("[qqbot-api] No cached token, retrying soon");
          await sleep(minRefreshIntervalMs, signal);
        }
      } catch (err) {
        if (signal.aborted) break;

        // 刷新失败，等待后重试
        log?.error?.(`[qqbot-api] Background token refresh failed: ${err}`);
        await sleep(retryDelayMs, signal);
      }
    }

    backgroundRefreshRunning = false;
    log?.info?.("[qqbot-api] Background token refresh stopped");
  };

  // 异步启动，不阻塞调用者
  refreshLoop().catch((err) => {
    backgroundRefreshRunning = false;
    log?.error?.(`[qqbot-api] Background token refresh crashed: ${err}`);
  });
}

/**
 * 停止后台 Token 刷新
 */
export function stopBackgroundTokenRefresh(): void {
  if (backgroundRefreshAbortController) {
    backgroundRefreshAbortController.abort();
    backgroundRefreshAbortController = null;
  }
  backgroundRefreshRunning = false;
}

/**
 * 检查后台 Token 刷新是否正在运行
 */
export function isBackgroundTokenRefreshRunning(): boolean {
  return backgroundRefreshRunning;
}

/**
 * 可中断的 sleep 函数
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("Aborted"));
        return;
      }

      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      };

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}