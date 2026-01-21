
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { encode, decode, decodeAudioData } from '../utils/audioUtils';

export class GeminiLiveService {
  private ai: GoogleGenAI;
  private sessionPromise: Promise<any> | null = null;
  private audioContextOut: AudioContext | null = null;
  private nextStartTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private onMessageCallback: (msg: string, type: 'assistant' | 'user' | 'system') => void;
  
  private currentInputTranscription = '';
  private currentOutputTranscription = '';

  constructor(apiKey: string, onMessage: (msg: string, type: 'assistant' | 'user' | 'system') => void) {
    this.ai = new GoogleGenAI({ apiKey });
    this.onMessageCallback = onMessage;
  }

  async connect(systemInstruction: string) {
    if (!this.audioContextOut) {
      this.audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    
    if (this.audioContextOut.state === 'suspended') {
      await this.audioContextOut.resume();
    }

    this.sessionPromise = this.ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
        },
        systemInstruction,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => {
          this.onMessageCallback("Neural link online.", 'system');
        },
        onmessage: async (message: LiveServerMessage) => {
          if (message.serverContent?.inputTranscription) {
            this.currentInputTranscription += message.serverContent.inputTranscription.text;
          }
          if (message.serverContent?.outputTranscription) {
            this.currentOutputTranscription += message.serverContent.outputTranscription.text;
          }

          if (message.serverContent?.turnComplete) {
            if (this.currentInputTranscription.trim()) {
              this.onMessageCallback(this.currentInputTranscription.trim(), 'user');
              this.currentInputTranscription = '';
            }
            if (this.currentOutputTranscription.trim()) {
              this.onMessageCallback(this.currentOutputTranscription.trim(), 'assistant');
              this.currentOutputTranscription = '';
            }
          }

          const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            this.playAudio(base64Audio);
          }

          if (message.serverContent?.interrupted) {
            this.stopAllAudio();
            this.currentOutputTranscription = ''; 
          }
        },
        onerror: (e) => {
          this.onMessageCallback("Link Error: Check signal/API key.", 'system');
        },
        onclose: () => {
          this.onMessageCallback("Link closed.", 'system');
        },
      }
    });

    return this.sessionPromise;
  }

  private async playAudio(base64: string) {
    if (!this.audioContextOut) return;
    try {
      this.nextStartTime = Math.max(this.nextStartTime, this.audioContextOut.currentTime);
      const audioBuffer = await decodeAudioData(decode(base64), this.audioContextOut, 24000, 1);
      const source = this.audioContextOut.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioContextOut.destination);
      source.start(this.nextStartTime);
      this.nextStartTime += audioBuffer.duration;
      this.sources.add(source);
      source.onended = () => this.sources.delete(source);
    } catch (err) {}
  }

  private stopAllAudio() {
    this.sources.forEach(s => { try { s.stop(); } catch(e) {} });
    this.sources.clear();
    this.nextStartTime = 0;
  }

  sendAudio(pcmBlob: Blob) {
    this.sessionPromise?.then((session) => {
      session.sendRealtimeInput({ media: pcmBlob });
    });
  }

  sendFrame(base64Image: string) {
    this.sessionPromise?.then((session) => {
      session.sendRealtimeInput({
        media: { data: base64Image, mimeType: 'image/jpeg' }
      });
    });
  }

  async disconnect() {
    const session = await this.sessionPromise;
    if (session) session.close();
    this.stopAllAudio();
    this.sessionPromise = null;
  }
}
