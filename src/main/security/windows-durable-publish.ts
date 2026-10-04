import * as koffi from 'koffi'
import { resolve, toNamespacedPath } from 'node:path'

/** 发布句柄同时需要写入与重命名权限，允许其他读取者继续打开对象。 */
const PUBLISH_ACCESS = 0x40000000 | 0x00010000
/** Windows 文件共享模式：读、写、删除；不把普通读取者变成重命名阻塞者。 */
const FILE_SHARING = 0x00000007
/** 只打开已写好的私有 staging，不意外创建空对象。 */
const OPEN_EXISTING = 3
/** 请求 NTFS 将该句柄的内容及重命名元数据写穿，并禁止跟随 staging 重解析点。 */
const PUBLISH_FLAGS = 0x80000000 + 0x00200000
/** FileRenameInfoEx 支持原子替换，并使已经打开的旧读句柄继续访问旧对象。 */
const RENAME_INFO_EX = 22
/** 替换现有目标并使用 POSIX 共享删除语义。 */
const RENAME_FLAGS = 0x00000001 | 0x00000002
/** 文件系统名称的 Win32 固定输出缓冲区字符数。 */
const FILESYSTEM_NAME_CHARS = 32
/** Win32 Unicode 字符的字节长度。 */
const WCHAR_BYTES = 2
/** 由原生指针宽度推导 INVALID_HANDLE_VALUE 的位数。 */
const BITS_PER_BYTE = 8

/** 在调用平台发布时才加载原生库，其他平台无需加载 kernel32。 */
function nativePublication() {
  const library = koffi.load('kernel32.dll')
  return {
    open: library.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint32', 'uint32', 'void *', 'uint32', 'uint32', 'void *']),
    flush: library.func('__stdcall', 'FlushFileBuffers', 'int', ['void *']),
    rename: library.func('__stdcall', 'SetFileInformationByHandle', 'int', ['void *', 'int', 'void *', 'uint32']),
    close: library.func('__stdcall', 'CloseHandle', 'int', ['void *']),
    error: library.func('__stdcall', 'GetLastError', 'uint32', []),
    filesystem: library.func('__stdcall', 'GetVolumeInformationByHandleW', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *', 'void *', 'void *', 'uint32'])
  }
}

/** 每进程只加载一次平台 DLL，其他平台不绑定 Windows 入口。 */
const windowsPublication = process.platform === 'win32' ? nativePublication() : null

/** 按实际指针宽度构造 Win32 可变长结构，避免把 64 位字段偏移写死。 */
function renameInformation(target: string): Buffer {
  const layout = koffi.struct({ flags: 'uint32', root: 'void *', length: 'uint32', name: koffi.array('uint16', 1) })
  const name = Buffer.from(toNamespacedPath(resolve(target)) + '\0', 'utf16le')
  const buffer = Buffer.alloc(koffi.sizeof(layout) + name.length)
  buffer.writeUInt32LE(RENAME_FLAGS, koffi.offsetof(layout, 'flags'))
  buffer.writeUInt32LE(name.length - WCHAR_BYTES, koffi.offsetof(layout, 'length'))
  name.copy(buffer, koffi.offsetof(layout, 'name'))
  return buffer
}

/** NTFS write-through 句柄完成 flush 与原子发布；任何平台错误必须先于耐久 ACK 暴露。 */
export function publishWindowsFile(source: string, target: string): void {
  const native = windowsPublication
  if (!native) throw new Error('DURABLE_PUBLISH_FAILED: Windows publication called on another platform')
  const handle = native.open(toNamespacedPath(resolve(source)), PUBLISH_ACCESS, FILE_SHARING, null, OPEN_EXISTING, PUBLISH_FLAGS, null)
  if (koffi.address(handle) === BigInt.asUintN(koffi.sizeof('void *') * BITS_PER_BYTE, -1n)) {
    throw new Error(`DURABLE_PUBLISH_FAILED: CreateFileW error ${native.error()}`)
  }
  try {
    const filesystem = Buffer.alloc(FILESYSTEM_NAME_CHARS * WCHAR_BYTES)
    if (!native.filesystem(handle, null, 0, null, null, null, filesystem, FILESYSTEM_NAME_CHARS)) {
      throw new Error(`DURABLE_PUBLISH_FAILED: volume query error ${native.error()}`)
    }
    if (filesystem.toString('utf16le').split('\0')[0] !== 'NTFS') {
      throw new Error('DURABLE_PUBLISH_UNSUPPORTED: Windows durable receipt requires NTFS namespace write-through')
    }
    if (!native.flush(handle)) throw new Error(`DURABLE_PUBLISH_FAILED: FlushFileBuffers error ${native.error()}`)
    const information = renameInformation(target)
    if (!native.rename(handle, RENAME_INFO_EX, information, information.length)) {
      throw new Error(`DURABLE_PUBLISH_FAILED: SetFileInformationByHandle error ${native.error()}`)
    }
    if (!native.flush(handle)) throw new Error(`DURABLE_PUBLISH_FAILED: post-publication flush error ${native.error()}`)
  } finally {
    // 包括发布失败在内都释放精确 staging 句柄，不改用复制或弱 rename。
    if (!native.close(handle)) throw new Error(`DURABLE_PUBLISH_FAILED: CloseHandle error ${native.error()}`)
  }
}
