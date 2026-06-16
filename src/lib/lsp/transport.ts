import {
  AbstractMessageReader,
  AbstractMessageWriter,
  type DataCallback,
  type Disposable,
  type Message,
  type MessageReader,
  type MessageWriter,
} from "vscode-jsonrpc/browser";

/**
 * Bridges `vscode-jsonrpc` to the Tauri transport. The Rust backend already
 * handles LSP `Content-Length` framing, so messages cross as complete JSON-RPC
 * strings: the reader parses incoming strings, and the writer hands outgoing
 * messages to a `send` callback (which calls the `lsp_send` command).
 */

export class TauriMessageReader extends AbstractMessageReader implements MessageReader {
  private callback: DataCallback | undefined;

  listen(callback: DataCallback): Disposable {
    this.callback = callback;
    return { dispose: () => (this.callback = undefined) };
  }

  /** Feed one raw JSON-RPC string received from the backend. */
  receive(raw: string): void {
    if (!this.callback) return;
    try {
      this.callback(JSON.parse(raw) as Message);
    } catch (e) {
      this.fireError(e instanceof Error ? e : new Error(String(e)));
    }
  }
}

export class TauriMessageWriter extends AbstractMessageWriter implements MessageWriter {
  private errorCount = 0;

  constructor(private readonly send: (message: string) => Promise<void>) {
    super();
  }

  async write(msg: Message): Promise<void> {
    try {
      await this.send(JSON.stringify(msg));
    } catch (e) {
      this.errorCount++;
      this.fireError(
        e instanceof Error ? e : new Error(String(e)),
        msg,
        this.errorCount,
      );
    }
  }

  end(): void {
    /* nothing buffered */
  }
}
