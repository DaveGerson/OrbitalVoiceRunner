export interface Terminal {
  id: string;
  cwd: string;
  command: string;
  output: string;
  status: "Running" | "Exited" | "Idle";
}

export interface PendingCommand {
  messageId: string;
  cmd: string;
  terminalId: string;
}
