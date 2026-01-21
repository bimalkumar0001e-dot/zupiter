
export class SerialService {
  // Using any because SerialPort type might not be available in the global scope
  private port: any | null = null;
  private writer: WritableStreamDefaultWriter<string> | null = null;
  private encoder = new TextEncoder();

  async requestPort(): Promise<boolean> {
    try {
      if (!('serial' in navigator)) {
        throw new Error('Web Serial API not supported in this browser.');
      }
      this.port = await (navigator as any).serial.requestPort();
      return !!this.port;
    } catch (err) {
      console.error('User cancelled port selection or error occurred:', err);
      return false;
    }
  }

  async connect(baudRate: number = 9600): Promise<boolean> {
    if (!this.port) return false;
    try {
      await this.port.open({ baudRate });
      const textEncoderStream = new TextEncoderStream();
      textEncoderStream.readable.pipeTo(this.port.writable!);
      this.writer = textEncoderStream.writable.getWriter();
      return true;
    } catch (err) {
      console.error('Failed to open serial port:', err);
      return false;
    }
  }

  async write(data: string) {
    if (!this.writer) {
      console.warn('Serial writer not initialized. Connect a device first.');
      return;
    }
    try {
      // Append a newline because most Arduino sketches use Serial.readStringUntil('\n') or similar
      await this.writer.write(data + '\n');
      console.log('Sent to Arduino:', data);
    } catch (err) {
      console.error('Error writing to serial port:', err);
    }
  }

  async disconnect() {
    if (this.writer) {
      await this.writer.close();
      this.writer = null;
    }
    if (this.port) {
      await this.port.close();
      this.port = null;
    }
  }
}