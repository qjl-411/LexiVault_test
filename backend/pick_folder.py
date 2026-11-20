"""Run in a separate process so Tk owns its main thread."""
import json
import sys
import tkinter as tk
from tkinter import filedialog

if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    root = tk.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    title = sys.argv[1] if len(sys.argv) > 1 else '选择 LexiVault 工作空间目录'
    selected = filedialog.askdirectory(title=title, mustexist=True)
    root.destroy()
    print(json.dumps(selected, ensure_ascii=False))
