import asyncio
import os
import sys
import re

IS_WINDOWS = sys.platform == "win32"

def strip_ansi_sequences(text: str) -> str:
    """Removes terminal escape characters to minimize token usage."""
    # Matches ANSI color/style escape sequences
    ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
    return ansi_escape.sub('', text)

class UniversalTerminal:
    def __init__(self, terminal_id: str, cwd: str, shell_cmd: str):
        self.terminal_id = terminal_id
        self.cwd = cwd
        self.shell_cmd = shell_cmd
        self.process = None
        self.output_buffer = []
        self.max_buffer_lines = 100

    async def start(self):
        """Starts the process based on OS type with real PTY capabilities."""
        if IS_WINDOWS:
            executable = "cmd.exe"
            args = ["/c", self.shell_cmd]
        else:
            executable = "script"
            if sys.platform == "darwin":
                args = ["-q", "/dev/null", "/bin/sh", "-c", self.shell_cmd]
            else:
                args = ["-q", "-f", "-c", self.shell_cmd, "/dev/null"]

        self.process = await asyncio.create_subprocess_exec(
            executable,
            *args,
            cwd=self.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # Spin up background reader task
        asyncio.create_task(self._read_stream())

    async def _read_stream(self):
        """Asynchronously reads and buffers stdout/stderr."""
        if not self.process or not self.process.stdout:
            return

        try:
            while True:
                line = await self.process.stdout.readline()
                if not line:
                    break
                decoded_line = line.decode('utf-8', errors='ignore')
                clean_line = strip_ansi_sequences(decoded_line).rstrip()
                
                self.output_buffer.append(clean_line)
                if len(self.output_buffer) > self.max_buffer_lines:
                    self.output_buffer.pop(0)
        except Exception as e:
            self.output_buffer.append(f"[Session error: {str(e)}]")

    async def write_input(self, command: str):
        """Writes standard input to process stream."""
        if self.process and self.process.stdin:
            payload = (command + "\n").encode('utf-8')
            self.process.stdin.write(payload)
            await self.process.stdin.drain()

    def get_recent_output(self, lines_count: int = 10) -> str:
        """Returns target slice of clean terminal history."""
        if not self.output_buffer:
            return ""
        requested_slice = self.output_buffer[-lines_count:]
        return "\n".join(requested_slice)

    async def stop(self):
        """Stops the subprocess if it is running."""
        if self.process:
            try:
                self.process.terminate()
                await self.process.wait()
            except Exception:
                pass
            self.process = None

