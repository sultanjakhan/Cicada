"""Windows QA filesystem handles. No ACL changes or production deployment."""
from contextlib import contextmanager
from pathlib import Path
import os
import msvcrt
import win32file
import win32con

def checked_handle(path, access, creation, directory=False, share=None):
    handle = win32file.CreateFile(str(path), access, (3 if directory else 0) if share is None else share, None,
                                creation, 0x00200000 | (0x02000000 if directory else 0), None)
    try:
        info = win32file.GetFileInformationByHandle(handle)
        if info[0] & 0x400 or bool(info[0] & 0x10) != directory or (not directory and info[7] != 1):
            raise RuntimeError('Unsafe QA filesystem alias')
        return handle
    except BaseException:
        handle.Close()
        raise

@contextmanager
def pinned_tree(root, create=False, scan=True):
    """Pin ordinary ancestor/tree directories; reject aliases before any writes."""
    root = Path(root).absolute()
    handles = []
    try:
        for path in [*reversed(root.parents), root]:
            if path == root and create:
                root.mkdir(exist_ok=False)
            handles.append(checked_handle(path, win32con.GENERIC_READ, win32con.OPEN_EXISTING, True))
        budget = 10000
        for parent, directories, files in os.walk(root, followlinks=False) if scan else []:
            for name in directories + files:
                budget -= 1
                if budget < 0:
                    raise RuntimeError('QA tree inspection limit exceeded')
                path = Path(parent) / name
                is_directory = name in directories
                handle = checked_handle(path, win32con.GENERIC_READ if is_directory else 0x80, win32con.OPEN_EXISTING, is_directory)
                if is_directory:
                    handles.append(handle)
                else:
                    handle.Close()
        yield
    finally:
        for handle in reversed(handles):
            handle.Close()

def writable_fd(path, new=False):
    handle = checked_handle(path, win32con.GENERIC_READ | win32con.GENERIC_WRITE,
                            win32con.CREATE_NEW if new else win32con.OPEN_ALWAYS)
    try:
        return msvcrt.open_osfhandle(handle.Detach(), os.O_RDWR | os.O_BINARY)
    except BaseException:
        handle.Close()
        raise

def write_bytes(path, data, new=False):
    fd = writable_fd(path, new)
    try:
        with os.fdopen(fd, 'r+b') as output:
            output.write(data)
            output.truncate()
    except BaseException:
        raise

def write_text(path, value, new=False):
    write_bytes(path, value.encode('utf-8'), new)

def read_text(path, limit=4096):
    return read_bytes(path, limit).decode('utf-8')

def read_bytes(path, limit=32 * 1024 * 1024):
    handle = checked_handle(path, win32con.GENERIC_READ, win32con.OPEN_EXISTING)
    try:
        size = win32file.GetFileSize(handle)
        if size > limit:
            raise RuntimeError('QA marker is too large')
        return win32file.ReadFile(handle, size)[1] if size else b''
    finally:
        handle.Close()
