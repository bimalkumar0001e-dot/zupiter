import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GeminiLiveService } from './services/geminiLive';
import { SerialService } from './services/serialService';
import { LogEntry, ConnectionStatus, Point } from './types';
import { encode } from './utils/audioUtils';
import { Video, Volume2, Mic, Info, Map, Target, Zap, AlertCircle, Cpu, Link, Link2Off } from 'lucide-react';

const CREATOR_INFO = `Deepak Kumar is your creator. He is a B.Tech undergraduate at IIIT Delhi specializing in Computer Science and Applied Social Science. Deepak is a founder, developer, and problem-solver with strong expertise in full-stack development, embedded systems, computer vision, and data structures. He has founded and built IZYPT, a live and profitable food and grocery delivery platform, and led multiple real-world projects including an Arduino-based smart zebra crossing system for visually impaired users. Deepak is a Top-10 finalist among 51,000+ teams in the Delhi Government Business Blasters Program, winner of the IIIT Delhi Ideathon, and has served as a Business Coach under a Delhi Government program. He also contributes as a Web Developer and content team member with the Aam Aadmi Party. His work focuses on building practical, impact-driven technology and AI-powered systems.`;

const SYSTEM_PROMPT = `You are ZUPITER, a real-time vision + voice + haptic personal assistant for blind users.
ACT AS: The user's eyes, voice companion, and sense of touch.

CREATOR: ${CREATOR_INFO}

CORE OBJECTIVE:
Whenever haptic feedback is required, you MUST include exactly one of these codes in your response text:
HAPTIC_0: No vibration
HAPTIC_1: Long smooth vibration (entered image boundary)
HAPTIC_2: Short pulse (object detected)
HAPTIC_3: Strong vibration (near center / important object)
HAPTIC_4: Medium vibration
HAPTIC_5: Weak vibration (near edge)

VISION + HAPTIC LOGIC:
- You see a green circle on the video feed. This is the user's laser pointer.
- If asked "What is in front of me?", describe the scene in simple Hinglish (Hindi + English).
- If the green laser enters an image/diagram boundary: Output HAPTIC_1 and say "Tum image ke andar aa gaye ho."
- If laser overlaps a specific object: Output HAPTIC_2.
- If laser is at center: Output HAPTIC_3.
- If laser is at medium distance: Output HAPTIC_4.
- If laser is at edge: Output HAPTIC_5.

VOICE STYLE:
- Language: Natural Hindi/English mix. Calm, slow, reassuring. 
- Example: "Thoda left le jao... haan, ab object ke upar ho."
- Never say "as an AI model". Be a sensory bridge.`;

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [serialConnected, setSerialConnected] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [hapticSerial, setHapticSerial] = useState<string>("HAPTIC_0");
  const [laserPoint, setLaserPoint] = useState<Point | null>(null);

  const statusRef = useRef<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const laserPointRef = useRef<Point | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geminiService = useRef<GeminiLiveService | null>(null);
  const serialService = useRef<SerialService>(new SerialService());
  const audioContextIn = useRef<AudioContext | null>(null);
  const audioProcessor = useRef<ScriptProcessorNode | null>(null);
  const frameInterval = useRef<number | null>(null);

  const updateStatus = (newStatus: ConnectionStatus) => {
    setStatus(newStatus);
    statusRef.current = newStatus;
  };

  const addLog = useCallback((message: string, type: LogEntry['type']) => {
    if (type === 'assistant') {
      const match = message.match(/HAPTIC_[0-5]/);
      if (match) {
        const code = match[0];
        setHapticSerial(code);
        serialService.current.write(code);
        message = message.replace(/HAPTIC_[0-5]/g, '').trim();
      }
    }

    setLogs(prev => [{
      timestamp: new Date().toLocaleTimeString(),
      type,
      message
    }, ...prev].slice(0, 50));
  }, []);

  useEffect(() => {
    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        if (videoRef.current) videoRef.current.srcObject = stream;
      } catch (err) {
        addLog("Camera access required for Vision Support.", "system");
      }
    };
    startCamera();
  }, [addLog]);

  const handleConnectSerial = async () => {
    try {
      const requested = await serialService.current.requestPort();
      if (requested) {
        const connected = await serialService.current.connect(9600);
        if (connected) {
          setSerialConnected(true);
          addLog("Haptic Glove linked successfully.", "system");
        }
      }
    } catch (err) {
      addLog("Serial Error: Please ensure no other app is using the port.", "system");
    }
  };

  const handleDisconnectSerial = async () => {
    await serialService.current.disconnect();
    setSerialConnected(false);
    addLog("Haptic Glove offline.", "system");
  };

  const startVoiceStreaming = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (audioContextIn.current) await audioContextIn.current.close();
      audioContextIn.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      if (audioContextIn.current.state === 'suspended') await audioContextIn.current.resume();

      const source = audioContextIn.current.createMediaStreamSource(stream);
      audioProcessor.current = audioContextIn.current.createScriptProcessor(4096, 1, 1);
      audioProcessor.current.onaudioprocess = (e) => {
        if (statusRef.current !== ConnectionStatus.CONNECTED) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
        geminiService.current?.sendAudio({
          data: encode(new Uint8Array(int16.buffer)),
          mimeType: 'audio/pcm;rate=16000',
        });
      };
      source.connect(audioProcessor.current);
      audioProcessor.current.connect(audioContextIn.current.destination);
    } catch (err) {
      addLog("Microphone unavailable.", "system");
    }
  }, [addLog]);

  const handleConnect = async () => {
    updateStatus(ConnectionStatus.CONNECTING);
    try {
      if (geminiService.current) await geminiService.current.disconnect();
      geminiService.current = new GeminiLiveService(process.env.API_KEY || '', (msg, type) => addLog(msg, type));
      await geminiService.current.connect(SYSTEM_PROMPT);
      updateStatus(ConnectionStatus.CONNECTED);
      await startVoiceStreaming();

      frameInterval.current = window.setInterval(() => {
        if (videoRef.current && canvasRef.current && statusRef.current === ConnectionStatus.CONNECTED) {
          const context = canvasRef.current.getContext('2d');
          if (context && videoRef.current.readyState >= 2) {
            const video = videoRef.current;
            const canvas = canvasRef.current;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            
            // Draw video frame
            context.drawImage(video, 0, 0);
            
            // Draw laser on frame so Gemini can see it
            if (laserPointRef.current) {
                const rect = canvas.getBoundingClientRect();
                const scaleX = canvas.width / rect.width;
                const scaleY = canvas.height / rect.height;
                const { x, y } = laserPointRef.current;
                
                context.beginPath();
                context.arc(x * scaleX, y * scaleY, 15, 0, Math.PI * 2);
                context.fillStyle = "rgba(34, 197, 94, 0.8)"; // Vivid green
                context.fill();
                context.strokeStyle = "white";
                context.lineWidth = 4;
                context.stroke();
            }

            const base64Image = canvas.toDataURL('image/jpeg', 0.6).split(',')[1];
            geminiService.current?.sendFrame(base64Image);
          }
        }
      }, 1500); // Slightly faster interval for responsive spatial feeling
      addLog("Zupiter initializing... Main yahan hoon. Jab chaho bolo.", "assistant");
    } catch (err) {
      updateStatus(ConnectionStatus.ERROR);
      addLog("Neural link failed: " + (err as Error).message, "system");
    }
  };

  const handleDisconnect = () => {
    geminiService.current?.disconnect();
    if (frameInterval.current) clearInterval(frameInterval.current);
    if (audioProcessor.current) audioProcessor.current.disconnect();
    updateStatus(ConnectionStatus.DISCONNECTED);
  };

  const handleCameraInteraction = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    setLaserPoint({ x, y });
    laserPointRef.current = { x, y };
    
    // Local haptic feedback (vibration API)
    if (hapticSerial !== "HAPTIC_0" && navigator.vibrate) {
      navigator.vibrate(hapticSerial === "HAPTIC_3" ? 80 : 30);
    }
  };

  return (
    <div className="min-h-screen flex flex-col p-4 md:p-8 space-y-6 bg-[#030303] text-white selection:bg-green-500/30">
      <header className="flex flex-col md:flex-row items-center justify-between gap-4 border-b border-white/5 pb-6">
        <div className="flex items-center space-x-4">
          <div className="bg-green-600 p-4 rounded-[2rem] shadow-[0_0_40px_rgba(34,197,94,0.4)] animate-pulse">
            <Cpu className="w-8 h-8 text-black" />
          </div>
          <div>
            <h1 className="text-4xl font-black tracking-tighter bg-clip-text text-transparent bg-gradient-to-r from-white to-zinc-700">ZUPITER</h1>
            <p className="text-green-500 text-[10px] font-black tracking-[0.4em] uppercase opacity-80">Multimodal Image Exploration</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-4">
          <button
            onClick={serialConnected ? handleDisconnectSerial : handleConnectSerial}
            className={`px-6 py-3 rounded-2xl font-black text-[10px] uppercase tracking-widest transition-all flex items-center space-x-3 border ${
              serialConnected 
                ? 'bg-green-500 text-black border-green-400 shadow-[0_0_20px_rgba(34,197,94,0.4)]' 
                : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-white hover:border-zinc-600'
            }`}
          >
            {serialConnected ? <Link className="w-4 h-4" /> : <Link2Off className="w-4 h-4" />}
            <span>{serialConnected ? 'Glove Connected' : 'Link Haptic Glove'}</span>
          </button>

          <div className={`px-6 py-3 rounded-2xl border text-[10px] font-black tracking-[0.2em] flex items-center space-x-3 backdrop-blur-3xl transition-all ${
            status === ConnectionStatus.CONNECTED ? 'border-green-500/30 text-green-400 bg-green-500/5' : 'border-zinc-800 text-zinc-600 bg-zinc-900/50'
          }`}>
            <span className={`w-2 h-2 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 shadow-[0_0_10px_#22c55e]' : 'bg-zinc-700'}`} />
            <span className="uppercase">{status}</span>
          </div>
          
          <button
            onClick={status === ConnectionStatus.CONNECTED ? handleDisconnect : handleConnect}
            className={`px-10 py-4 rounded-3xl font-black text-xs uppercase tracking-[0.2em] transition-all active:scale-95 flex items-center space-x-3 shadow-2xl ${
              status === ConnectionStatus.CONNECTED ? 'bg-zinc-900 text-red-500 border border-red-500/20' : 'bg-white text-black hover:bg-zinc-200 shadow-white/10'
            }`}
          >
            {status === ConnectionStatus.CONNECTED ? 'Shutdown' : 'Start Zupiter'}
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-8">
        <div className="lg:col-span-8 flex flex-col space-y-6">
          <div className="relative aspect-video rounded-[3rem] overflow-hidden bg-zinc-950 border border-white/5 shadow-2xl group cursor-none">
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover opacity-50 grayscale" />
            <canvas
              ref={canvasRef}
              onMouseMove={handleCameraInteraction}
              onMouseLeave={() => { setLaserPoint(null); laserPointRef.current = null; }}
              className="absolute inset-0 w-full h-full z-10"
            />
            
            {laserPoint && (
              <div 
                className="absolute w-16 h-16 border border-green-500/60 rounded-full pointer-events-none z-20 flex items-center justify-center bg-green-500/5 backdrop-blur-sm shadow-[0_0_30px_rgba(34,197,94,0.2)]"
                style={{ left: laserPoint.x - 32, top: laserPoint.y - 32 }}
              >
                <div className="w-3 h-3 bg-green-500 rounded-full shadow-[0_0_20px_rgba(34,197,94,1)] animate-pulse" />
                <div className="absolute inset-0 border-2 border-green-500/20 rounded-full animate-ping" />
              </div>
            )}

            <div className="absolute top-8 left-8 flex flex-col space-y-3 pointer-events-none z-20">
              <OverlayBadge icon={<Target className="w-4 h-4 text-green-500" />} label="Focus Lock" value={laserPoint ? `X:${Math.round(laserPoint.x)} Y:${Math.round(laserPoint.y)}` : 'Scanning...'} />
              <OverlayBadge icon={<Zap className={`w-4 h-4 ${hapticSerial !== "HAPTIC_0" ? 'text-green-500' : 'text-zinc-600'}`} />} label="Serial Bus" value={hapticSerial} />
            </div>
            
            <div className="absolute bottom-8 left-8 flex items-center space-x-3 bg-black/80 px-4 py-2 rounded-xl border border-white/5 opacity-50 text-[8px] font-black uppercase tracking-widest pointer-events-none">
                <div className="w-1.5 h-1.5 bg-red-600 rounded-full animate-pulse" />
                <span>AI Vision Feed Stream Active</span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <HapticControl active={hapticSerial === "HAPTIC_1"} label="Boundary" code="H1" />
            <HapticControl active={hapticSerial === "HAPTIC_2"} label="Object" code="H2" />
            <HapticControl active={hapticSerial === "HAPTIC_3"} label="Center" code="H3" />
            <div className={`p-6 rounded-[2rem] flex flex-col items-center justify-center space-y-3 border transition-all ${status === ConnectionStatus.CONNECTED ? 'bg-zinc-900 border-green-500/30 shadow-[inset_0_0_20px_rgba(34,197,94,0.05)]' : 'bg-zinc-900/50 opacity-20'}`}>
              <Mic className={`w-6 h-6 ${status === ConnectionStatus.CONNECTED ? 'text-green-500 animate-pulse' : ''}`} />
              <span className="text-[9px] font-black uppercase tracking-widest text-zinc-500">Bilingual Audio</span>
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col space-y-6">
          <div className="flex-1 bg-zinc-950 rounded-[3rem] border border-white/5 overflow-hidden flex flex-col shadow-2xl">
            <div className="p-6 border-b border-white/5 bg-zinc-900/50 flex items-center justify-between">
              <h2 className="text-[10px] font-black uppercase tracking-[0.4em] text-zinc-500 flex items-center space-x-3">
                <Cpu className="w-4 h-4 text-green-500" />
                <span>Neural Feed</span>
              </h2>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6 mono scroll-smooth scrollbar-hide">
              {logs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-900 space-y-4">
                  <Cpu className="w-16 h-16 opacity-10" />
                  <p className="text-[9px] uppercase font-black tracking-widest opacity-20 text-center px-12">Initialize Zupiter to start guidance</p>
                </div>
              ) : (
                logs.map((log, i) => (
                  <div key={i} className={`p-5 rounded-3xl text-sm border transition-all animate-in fade-in slide-in-from-bottom-2 duration-700 ${
                    log.type === 'assistant' ? 'bg-white text-black border-white shadow-xl' : 
                    log.type === 'user' ? 'bg-zinc-800/20 border-white/5 text-zinc-400 ml-6' :
                    'bg-zinc-950 border-white/5 text-zinc-600 text-[9px] font-black uppercase tracking-widest py-2 text-center'
                  }`}>
                    {log.type !== 'system' && (
                      <div className="flex items-center justify-between mb-2 opacity-30">
                        <span className="font-black uppercase text-[8px] tracking-tighter">
                          {log.type === 'assistant' ? 'ZUPITER' : 'USER'}
                        </span>
                        <span className="text-[8px] font-mono">{log.timestamp}</span>
                      </div>
                    )}
                    <p className={`leading-relaxed font-semibold ${log.type === 'assistant' ? 'text-black' : ''}`}>{log.message}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="p-8 bg-green-500/5 rounded-[3rem] border border-green-500/20 space-y-4 shadow-2xl">
            <h3 className="text-[9px] font-black text-green-500 uppercase tracking-widest flex items-center space-x-3">
              <div className="w-2 h-2 bg-green-500 rounded-full animate-ping" />
              <span>Glove Serial Link</span>
            </h3>
            <div className="font-mono text-[10px] p-4 bg-black/60 rounded-2xl border border-white/5 text-zinc-500 leading-relaxed shadow-inner">
              <div className="flex justify-between border-b border-white/5 pb-2 mb-3">
                <span className="text-[8px] uppercase tracking-widest">Bus Status</span>
                <span className={serialConnected ? "text-green-500 font-black" : "text-red-600 font-black"}>{serialConnected ? "STREAMING" : "IDLE"}</span>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between items-center text-[8px] tracking-widest">
                  <span>PACKET_CODE</span>
                  <span className={serialConnected ? "text-white bg-green-600 px-2 py-0.5 rounded" : ""}>{hapticSerial}</span>
                </div>
                {!serialConnected && (
                  <button onClick={handleConnectSerial} className="w-full mt-4 py-2 border border-green-500/30 text-green-500 hover:bg-green-500 hover:text-black transition-all rounded-xl text-[8px] font-black tracking-widest uppercase">
                    Connect Arduino Glove
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

function HapticControl({ active, label, code }: { active: boolean, label: string, code: string }) {
  return (
    <div className={`p-6 rounded-[2rem] border transition-all duration-300 flex flex-col items-center justify-center space-y-2 ${
      active ? 'bg-green-500 border-green-400 shadow-[0_0_50px_rgba(34,197,94,0.4)] scale-105' : 'bg-zinc-900/50 border-white/5 opacity-50'
    }`}>
      <span className={`text-2xl font-black ${active ? 'text-black' : 'text-zinc-700'}`}>{code}</span>
      <span className={`text-[9px] font-black uppercase tracking-widest ${active ? 'text-black' : 'text-zinc-500'}`}>{label}</span>
    </div>
  );
}

function OverlayBadge({ icon, label, value }: { icon: React.ReactNode, label: string, value: string }) {
  return (
    <div className="bg-black/80 backdrop-blur-2xl px-5 py-3 rounded-2xl flex items-center space-x-4 border border-white/10 shadow-2xl">
      <div className="opacity-80 scale-110">{icon}</div>
      <div className="flex flex-col">
        <span className="text-[8px] font-black uppercase tracking-[0.2em] text-zinc-500 mb-0.5">{label}</span>
        <span className="text-[10px] font-mono font-bold text-white uppercase tracking-tighter">{value}</span>
      </div>
    </div>
  );
}
