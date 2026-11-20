"""Validate untrusted PDF structure in a separately terminable process."""
import json
import subprocess
import sys
from pathlib import Path

from pypdf import PdfReader


def validate_pdf(path):
    from .storage import StoreError

    try:
        result = subprocess.run(
            [sys.executable, '-m', 'backend.inspect_pdf', str(path)],
            capture_output=True, encoding='utf-8', timeout=30,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
    except subprocess.TimeoutExpired as error:
        raise StoreError('PDF 校验超过 30 秒，已停止处理；请检查文件或拆分后重试。', 408) from error
    try:
        report = json.loads(result.stdout)
    except ValueError as error:
        raise StoreError('PDF 校验进程未完成，文件未入库。') from error
    if report.get('error'):
        raise StoreError(report['error'])
    return report['pages']


def inspect(path):
    try:
        reader = PdfReader(path, strict=False)
        if reader.is_encrypted:
            return {"error": "暂不支持加密 PDF，请先解密后导入。"}
        count = len(reader.pages)
        if count < 1 or count > 3000:
            return {"error": "PDF 页数需在 1 至 3000 页之间。"}
        return {"pages": count}
    except Exception:
        return {"error": "无法读取这份 PDF，可能已损坏；文件未入库。"}


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(inspect(sys.argv[1]), ensure_ascii=False))
