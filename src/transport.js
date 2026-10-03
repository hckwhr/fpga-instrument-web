// HC-05 is Classic Bluetooth SPP, not BLE/GATT. The OS exposes it as
// a serial port; desktop Chromium Web Serial owns the permission picker.
export class Transport {
  constructor(serial = globalThis.navigator?.serial) {
    this.serial = serial;
    this.connected = false;
    this.state = 'disconnected';
    this.listeners = new Set();
    this.dataListeners = new Set();
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.pendingWrites = 0;
    this.writeTail = Promise.resolve();
    this.onUnplug = (event) => {
      if ((event.port || event.target) === this.port) {
        void this.disconnect('设备连接已断开').catch(() => {});
      }
    };
  }

  onStatus(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onData(listener) { this.dataListeners.add(listener); return () => this.dataListeners.delete(listener); }
  emit(state, message) {
    this.state = state;
    this.connected = state === 'connected';
    for (const listener of this.listeners) listener({ state, connected: this.connected, message });
  }
  async connect({ baudRate = 9600 } = {}) {
    if (!this.serial) throw new Error('此浏览器不支持 Web Serial；HC-05 请使用电脑 Chrome/Edge，安卓需后续 App。');
    if (globalThis.isSecureContext === false) throw new Error('连接需要 HTTPS 或 localhost 页面。');
    if (this.state !== 'disconnected') throw new Error('当前连接操作尚未结束');
    if (![9600, 19200, 38400, 57600, 115200].includes(baudRate)) throw new Error('请选择支持的波特率');
    this.emit('connecting', '请选择已配对 HC-05 的串口或 USB 串口');
    let port;
    try {
      port = await this.serial.requestPort();
      await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
      if (!port.readable || !port.writable) throw new Error('串口没有可用的收发通道');
      this.port = port;
      this.writer = port.writable.getWriter();
      this.reader = port.readable.getReader();
      this.serial.addEventListener('disconnect', this.onUnplug);
      this.emit('connected', '串口已打开 · 板端协议尚未确认');
      this.readTask = this.readLoop();
    } catch (error) {
      this.writer?.releaseLock(); this.reader?.releaseLock();
      this.writer = null; this.reader = null; this.port = null;
      if (port) await port.close().catch(() => {});
      this.emit('disconnected', error.name === 'NotFoundError' ? '已取消选择设备' : `连接失败：${error.message}`);
      throw error;
    }
  }
  async readLoop() {
    const decoder = new TextDecoder();
    let reason = '串口接收已结束';
    try {
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        // Incremental decoding preserves UTF-8 characters split across chunks.
        const text = decoder.decode(value, { stream: true });
        if (text) for (const listener of this.dataListeners) listener(text);
      }
      const tail = decoder.decode();
      if (tail) for (const listener of this.dataListeners) listener(tail);
    } catch (error) { reason = `接收中断：${error.message}`; }
    finally { this.reader?.releaseLock(); this.reader = null; }
    // Defer cleanup so disconnect can await this task without self-deadlock.
    if (this.connected) queueMicrotask(() => { void this.disconnect(reason).catch(() => {}); });
  }
  async sendText(text, { newline = true } = {}) {
    if (!this.connected) throw new Error('请先连接串口');
    const bytes = new TextEncoder().encode(text + (newline ? '\n' : ''));
    if (!text.trim() || bytes.length > 256) throw new Error('测试文本不能为空，含换行最多 256 字节');
    if (this.pendingWrites >= 8) throw new Error('发送队列已满，请稍后重试');
    const writer = this.writer;
    this.pendingWrites += 1;
    const task = this.writeTail.then(async () => {
      if (!this.connected || writer !== this.writer) throw new Error('连接已断开，未发送');
      await writer.write(bytes);
      return bytes.length;
    });
    this.writeTail = task.catch(() => {});
    try { return await task; }
    catch (error) {
      if (this.connected) void this.disconnect(`发送失败：${error.message}`).catch(() => {});
      throw error;
    } finally { this.pendingWrites -= 1; }
  }
  disconnect(message = '已断开串口') {
    if (this.state === 'connecting') return Promise.reject(new Error('请先关闭设备选择窗口'));
    if (this.closing) return this.closing;
    if (!this.port) return Promise.resolve();
    this.emit('disconnecting', '正在断开串口');
    this.closing = this.closePort(message).finally(() => { this.closing = null; });
    return this.closing;
  }
  async closePort(message) {
    this.serial.removeEventListener('disconnect', this.onUnplug);
    try {
      await Promise.allSettled([this.reader?.cancel(), this.writer?.abort()]);
      await this.readTask;
      await this.writeTail;
      this.writer?.releaseLock(); this.writer = null;
      await this.port.close();
    } finally {
      this.port = null; this.reader = null; this.writer = null;
      this.emit('disconnected', message);
    }
  }
}
