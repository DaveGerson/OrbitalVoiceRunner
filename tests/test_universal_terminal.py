import sys
import os
import asyncio
import unittest

# Ensure the root directory is accessible for imports
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(ROOT_DIR)

from universal_terminal import UniversalTerminal, strip_ansi_sequences


def _delete_scrollback(terminal_id: str) -> None:
    """Remove the scrollback log file created by a test terminal, if present."""
    path = os.path.join(ROOT_DIR, f".janus_scrollback_{terminal_id}.log")
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass


class TestUniversalTerminal(unittest.IsolatedAsyncioTestCase):

    def test_strip_ansi_sequences_unit(self):
        """Unit test: verifies that ANSI styling and color sequences are correctly stripped."""
        text_with_ansi = "\x1b[31;1mCritical Error:\x1b[0m \x1b[32mSystem rebooting...\x1b[0m"
        clean_text = strip_ansi_sequences(text_with_ansi)
        self.assertEqual(clean_text, "Critical Error: System rebooting...")

    async def test_terminal_lifecycle_integration(self):
        """Integration test: verifies process spawning, automatic buffering, and clean shutdown."""
        self.addCleanup(_delete_scrollback, "test-lifecycle")
        # Use platform-agnostic echo
        cmd = "echo hello validation" if sys.platform == "win32" else "echo 'hello validation'"

        term = UniversalTerminal(terminal_id="test-lifecycle", cwd=".", shell_cmd=cmd)
        await term.start()
        
        # Give the process a brief moment to execute and flush stdout
        await asyncio.sleep(1)
        
        output = term.get_recent_output(10)
        self.assertIn("hello validation", output)
        
        # Clean shutdown
        await term.stop()
        self.assertIsNone(term.process)

    async def test_terminal_input_integration(self):
        """Integration test: verifies the ability to stream standard input into an active session."""
        self.addCleanup(_delete_scrollback, "test-input")
        # Use an interactive shell to accept continuous input
        cmd = "cmd.exe" if sys.platform == "win32" else "sh"

        term = UniversalTerminal(terminal_id="test-input", cwd=".", shell_cmd=cmd)
        await term.start()
        
        # Give shell time to initialize
        await asyncio.sleep(0.5) 
        
        # Send an instruction to the active terminal
        echo_cmd = "echo async_input_received"
        await term.write_input(echo_cmd)
        
        # Give process time to handle the stdin pipe and flush stdout
        await asyncio.sleep(1)
        
        output = term.get_recent_output(10)
        self.assertIn("async_input_received", output)
        
        # Issue an exit command to allow the shell to self-terminate cleanly (if applicable)
        await term.write_input("exit")
        await term.stop()

if __name__ == '__main__':
    unittest.main()
