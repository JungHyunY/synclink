const { Server } = require("socket.io");

const io = new Server(3001, {
  cors: { origin: "*" },
});

console.log("📡 Signaling Server running on port 3001");

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on("join-room", (roomId) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room: ${roomId}`);
    socket.to(roomId).emit("user-connected", socket.id);
  });

  socket.on("offer", (payload) => {
    console.log(`➡️ Offer: ${payload.caller} -> ${payload.target}`);
    io.to(payload.target).emit("offer", payload);
  });

  socket.on("answer", (payload) => {
    console.log(`⬅️ Answer: to ${payload.target}`);
    io.to(payload.target).emit("answer", payload);
  });

  socket.on("ice-candidate", (payload) => {
    io.to(payload.target).emit("ice-candidate", payload);
  });

  // [핵심 수정] 제어 신호 중계 및 로그 출력
  socket.on("control-event", (payload) => {
    // 여기에 로그가 안 찍히면 Guest가 안 보내고 있는 것임
    console.log(`🎮 Control: ${payload.type} (x:${payload.x?.toFixed(2)}, y:${payload.y?.toFixed(2)}) -> Room: ${payload.targetRoom}`);
    
    // 나(Guest)를 제외한 방 안의 사람(Host)에게 전송
    socket.to(payload.targetRoom).emit("control-event", payload);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});