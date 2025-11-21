import { useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Monitor, Cast, Power, Hash, MousePointer2 } from "lucide-react"; 
import "./App.css";

const SIGNALING_SERVER_URL = "http://183.111.166.141:3001"; 
const ICE_SERVERS = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function App() {
  const [roomId, setRoomId] = useState("");
  const [status, setStatus] = useState("Ready");
  const [isHostMode, setIsHostMode] = useState(false); 
  const [isConnected, setIsConnected] = useState(false); 
  const [ghostCursor, setGhostCursor] = useState({ x: 0.5, y: 0.5 });
  const [monitorIndex, setMonitorIndex] = useState(0);
  const [permissionGranted, setPermissionGranted] = useState(true);
  // [핵심] 리스너 내부에서 최신 값을 읽기 위한 Ref 추가
  const activeMonitorRef = useRef(0);

  const socketRef = useRef<Socket | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement>(null);
  const isHostRef = useRef(false);
  const candidateQueue = useRef<RTCIceCandidate[]>([]);

  // 모니터 변경 함수 (State와 Ref 동시 업데이트)
  const updateMonitorIndex = (index: number) => {
      setMonitorIndex(index);
      activeMonitorRef.current = index;
  };

  useEffect(() => {
    // 앱 시작 시 권한 체크
    const check = async () => {
        const granted = await invoke<boolean>("check_permissions");
        setPermissionGranted(granted);
        
        if (!granted) {
            console.warn("⚠️ Mac permissions missing!");
        }
    };
    check();
    
    // (선택사항) 사용자가 설정을 켜고 돌아왔을 때를 대비해 2초마다 체크할 수도 있음
    const interval = setInterval(check, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    socketRef.current = io(SIGNALING_SERVER_URL);
    const socket = socketRef.current;

    socket.on("connect", () => { console.log("✅ Connected"); });

    // ... (WebRTC 로직 생략 - 기존과 동일) ...
    socket.on("user-connected", async (userId) => {
        if (!isHostRef.current || !peerRef.current) return;
        setStatus("Connecting...");
        try {
            const offer = await peerRef.current.createOffer();
            await peerRef.current.setLocalDescription(offer);
            socket.emit("offer", { target: userId, caller: socket.id, sdp: offer });
        } catch (e) { console.error(e); }
    });
    socket.on("offer", async (payload) => {
        const peer = createPeerConnection(payload.caller);
        try {
            await peer.setRemoteDescription(payload.sdp);
            processCandidateQueue(peer);
            const answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            socket.emit("answer", { target: payload.caller, sdp: answer });
            setIsConnected(true);
        } catch (e) { console.error(e); }
    });
    socket.on("answer", async (payload) => {
        if (peerRef.current) {
            await peerRef.current.setRemoteDescription(payload.sdp);
            processCandidateQueue(peerRef.current);
            setStatus("Session Active");
            setIsConnected(true);
        }
    });
    socket.on("ice-candidate", async (payload) => {
        const peer = peerRef.current;
        if (peer) {
            if (!peer.remoteDescription) candidateQueue.current.push(payload.candidate);
            else await peer.addIceCandidate(payload.candidate).catch(e => console.error(e));
        }
    });

    // 🎮 [제어 신호 수신]
    socket.on("control-event", async (payload) => {
        if (isHostRef.current) {
            try {
                if (payload.type === "mousemove") {
                    // [Fail-safe] Guest가 보는 화면과 내 화면이 다르면 강제 동기화
                    // Ref를 사용하므로 항상 최신 값을 비교할 수 있음
                    if (payload.monitorIndex !== undefined && payload.monitorIndex !== activeMonitorRef.current) {
                         console.log(`⚠️ Auto-Switching to Monitor ${payload.monitorIndex}`);
                         updateMonitorIndex(payload.monitorIndex);
                         await invoke("start_screen_capture", { monitorIndex: payload.monitorIndex });
                    }

                    setGhostCursor({ x: payload.x, y: payload.y });
                    // 현재 활성화된 모니터 기준(activeMonitorRef)으로 마우스 이동
                    await invoke("remote_mouse_move", { 
                        x: payload.x, 
                        y: payload.y, 
                        monitorIndex: activeMonitorRef.current 
                    });
                } 
                else if (payload.type === "click") {
                    await invoke("remote_mouse_click", { button: payload.button });
                } 
                else if (payload.type === "keydown" || payload.type === "keyup") {
                    const state = payload.type === "keydown" ? "down" : "up";
                    await invoke("remote_keyboard_event", { state, key: payload.key });
                }
                // 명시적 전환 요청
                else if (payload.type === "switch-monitor") {
                    console.log(`🔄 Switch Request: Monitor ${payload.monitorIndex}`);
                    updateMonitorIndex(payload.monitorIndex);
                    await invoke("start_screen_capture", { monitorIndex: payload.monitorIndex });
                }

            } catch (err) { console.error(err); }
        }
    });
    return () => { socket.disconnect(); };
  }, []);

  // ... (Video Frame 수신 로직 동일) ...
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    const startListening = async () => {
      unlisten = await listen<string>("video-frame", (event) => {
        const canvas = captureCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const img = new Image();
        img.onload = () => {
            if (canvas.width !== img.width) canvas.width = img.width;
            if (canvas.height !== img.height) canvas.height = img.height;
            ctx.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${event.payload}`;
      });
    };
    if (isHostMode) startListening();
    return () => { if (unlisten) unlisten(); };
  }, [isHostMode]);

  // ... (Helper Functions 동일) ...
  const createPeerConnection = (targetId: string) => {
    const peer = new RTCPeerConnection(ICE_SERVERS);
    peer.onicecandidate = (e) => { if(e.candidate) socketRef.current?.emit("ice-candidate", { target: targetId, candidate: e.candidate }); };
    peer.ontrack = (e) => {
      setStatus("Connected");
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = e.streams[0];
        remoteVideoRef.current.play().catch(e => console.error(e));
      }
    };
    return peer;
  };
  const processCandidateQueue = async (peer: RTCPeerConnection) => {
      while (candidateQueue.current.length > 0) { const c = candidateQueue.current.shift(); if(c) peer.addIceCandidate(c); }
  };

  // Guest 요청 처리
  const requestMonitorSwitch = (newIndex: number) => {
      updateMonitorIndex(newIndex); // State + Ref 업데이트
      
      if (isHostMode) {
          invoke("start_screen_capture", { monitorIndex: newIndex });
      } else {
          socketRef.current?.emit("control-event", { 
              targetRoom: roomId, 
              type: "switch-monitor", 
              monitorIndex: newIndex 
          });
      }
  };

  const startHosting = async () => {
    if (!roomId) return alert("Please enter a Room ID");
    isHostRef.current = true;
    setIsHostMode(true);
    setIsConnected(true);
    setStatus("Hosting...");
    socketRef.current?.emit("join-room", roomId);

    try {
      // Ref 값 사용
      await invoke("start_screen_capture", { monitorIndex: Number(activeMonitorRef.current) });

      if (!captureCanvasRef.current) return;
      const canvas = captureCanvasRef.current as any;
      const stream = canvas.captureStream(30); 
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      const peer = createPeerConnection("unknown"); 
      stream.getTracks().forEach((track: any) => peer.addTrack(track, stream));
      peerRef.current = peer; 
    } catch (err) { 
        console.error(err);
        setIsHostMode(false);
        setIsConnected(false);
        isHostRef.current = false;
    }
  };

  const joinStream = () => {
    if (!roomId) return alert("Please enter a Room ID");
    isHostRef.current = false;
    setIsHostMode(false);
    setIsConnected(true); 
    setStatus("Connecting...");
    peerRef.current = null; 
    socketRef.current?.emit("join-room", roomId);
  };

  const disconnect = () => window.location.reload();

  const handleRemoteInput = (e: React.MouseEvent, type: string) => {
      if (isHostRef.current) return; 
      const video = e.currentTarget as HTMLVideoElement;
      if (type === 'click') { const wrapper = video.parentElement; if (wrapper) wrapper.focus(); }
      const rect = video.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      // [중요] Guest도 현재 monitorIndex를 담아서 보냄
      if (type === 'mousemove') {
          if (e.movementX * e.movementX + e.movementY * e.movementY > 10) {
             socketRef.current?.emit("control-event", { 
                 targetRoom: roomId, 
                 type: "mousemove", 
                 x, 
                 y, 
                 monitorIndex // 현재 state 값 전송
             });
          }
      } else if (type === 'click') {
          socketRef.current?.emit("control-event", { targetRoom: roomId, type: "click", button: "left" });
      }
  };

  const handleKeyInput = (e: React.KeyboardEvent, type: 'keydown' | 'keyup') => {
      if (isHostRef.current) return;
      socketRef.current?.emit("control-event", { targetRoom: roomId, type: type, key: e.key });
  };

  return (
    <div className="container">
      {!permissionGranted && (
        <div style={{
            position: 'absolute', top: 0, left: 0, right: 0,
            background: '#ef4444', color: 'white', padding: '12px',
            display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '15px',
            zIndex: 9999
        }}>
            <span>⚠️ 원격 제어를 위해 '손쉬운 사용' 권한이 필요합니다.</span>
            <button 
                onClick={() => invoke("open_permission_settings")}
                style={{
                    padding: '6px 12px', borderRadius: '4px', border: 'none', 
                    background: 'white', color: '#ef4444', fontWeight: 'bold', cursor: 'pointer'
                }}
            >
                설정 열기 ⚙️
            </button>
        </div>
      )}
      <canvas ref={captureCanvasRef} style={{ position: 'absolute', top: -9999, left: -9999, visibility: 'hidden' }} />
      
      {!isConnected ? (
        <div className="lobby">
          <div className="brand"><h1>SyncLink<span style={{color:'#3b82f6'}}>.</span></h1><p>Remote Control</p></div>
          <div className="login-card">
            <div className="input-group">
              <Hash className="input-icon" size={20} />
              <input className="room-input" placeholder="Enter Room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
            </div>
            <div className="input-group" style={{ marginTop: '10px' }}>
               <Monitor className="input-icon" size={20} />
               <select className="room-input" value={monitorIndex} onChange={(e) => updateMonitorIndex(Number(e.target.value))}>
                 <option value={0}>Monitor 1</option>
                 <option value={1}>Monitor 2</option>
               </select>
            </div>
            <div className="action-buttons" style={{marginTop:'20px'}}>
              <button className="btn btn-primary" onClick={startHosting}><Cast size={18} /> Host</button>
              <button className="btn btn-secondary" onClick={joinStream}><Monitor size={18} /> Connect</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="session-header">
            <div className="status-badge"><div className="status-dot"></div><span>{status}</span></div>
            <div className="monitor-switcher" style={{ marginLeft: 'auto', marginRight: '10px' }}>
                <select className="room-input" style={{ padding: '8px', fontSize: '0.9rem', width: 'auto' }}
                    value={monitorIndex}
                    onChange={(e) => requestMonitorSwitch(Number(e.target.value))}
                >
                    <option value={0}>Display 1</option>
                    <option value={1}>Display 2</option>
                </select>
            </div>
            <button className="btn btn-danger" onClick={disconnect}><Power size={16} /> End</button>
          </div>

          <div className="video-container">
            {isHostMode && (
                <div className="video-wrapper">
                    <video ref={localVideoRef} autoPlay playsInline muted />
                    <div className="ghost-cursor" style={{ left: `${ghostCursor.x * 100}%`, top: `${ghostCursor.y * 100}%` }}>
                        <MousePointer2 size={16} color="#ef4444" />
                    </div>
                </div>
            )}
            {!isHostMode && (
                <div className="video-wrapper" tabIndex={0} onKeyDown={(e) => handleKeyInput(e, 'keydown')} onKeyUp={(e) => handleKeyInput(e, 'keyup')}>
                    <video ref={remoteVideoRef} autoPlay playsInline muted onClick={(e) => handleRemoteInput(e, 'click')} onMouseMove={(e) => handleRemoteInput(e, 'mousemove')} />
                </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

export default App;