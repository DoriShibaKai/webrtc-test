import { DurableObject } from "cloudflare:workers";

/*
 * 通常のWebページへのアクセスと，
 * WebRTC接続に必要なメッセージの受け渡しを振り分けます。
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /ws/部屋名 へのアクセスだけを接続用として処理
    if (url.pathname.startsWith("/ws/")) {
      const roomName = decodeURIComponent(
        url.pathname.slice("/ws/".length)
      ).trim();

      if (!roomName) {
        return new Response("部屋名がありません。", { status: 400 });
      }

      // 同じ部屋名の利用者を，同じ接続場所へ案内
      const id = env.ROOMS.idFromName(roomName);
      const room = env.ROOMS.get(id);

      return room.fetch(request);
    }

    // それ以外はWebページを表示
    return env.ASSETS.fetch(request);
  },
};

/*
 * 同じ部屋に入ったiPhoneとPCの間で，
 * WebRTC接続用の情報を中継します。
 */
export class SignalingRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");

    if (upgradeHeader?.toLowerCase() !== "websocket") {
      return new Response("WebSocket接続専用です。", { status: 426 });
    }

    const currentSockets = this.ctx.getWebSockets();

    // 今回はiPhoneとPCの2台だけ
    if (currentSockets.length >= 2) {
      return new Response(
        "この部屋にはすでに2台接続されています。",
        { status: 409 }
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Cloudflare側で接続を保持
    this.ctx.acceptWebSocket(server);

    // 現在何台目かを通知
    server.send(
      JSON.stringify({
        type: "joined",
        position: currentSockets.length + 1,
      })
    );

    // すでに入っている相手にも通知
    for (const socket of currentSockets) {
      try {
        socket.send(
          JSON.stringify({
            type: "peer-joined",
          })
        );
      } catch {
        // 切断済みなら無視
      }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(sender, message) {
    // 受け取った接続情報を，相手側だけへ送る
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender) continue;

      try {
        socket.send(message);
      } catch {
        // 切断済みなら無視
      }
    }
  }

  async webSocketClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // すでに閉じている場合は無視
    }

    // 残った相手へ切断を通知
    for (const remaining of this.ctx.getWebSockets()) {
      try {
        remaining.send(
          JSON.stringify({
            type: "peer-left",
          })
        );
      } catch {
        // 切断済みなら無視
      }
    }
  }

  async webSocketError(socket) {
    try {
      socket.close(1011, "WebSocket error");
    } catch {
      // すでに閉じている場合は無視
    }
  }
}
