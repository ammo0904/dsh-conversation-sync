// DSH session JSONL 的 Zstandard 串接框架讀寫工具。
//
// DSH 的 session 檔（session.v4.jsonl.zstd）是「多個獨立可解碼、各自帶檢查碼的
// Zstandard 框架」串接而成：第一格是 header，其後每格是一批事件。
// Node 的 zstdDecompressSync 一次只解一格，因此必須先掃描框架邊界再逐格解壓。
//
// 本模組只使用 Node 內建模組，演算法與 DSH 的 scanZstdFrames 相同。
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = 4247762216
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 掃描串接框架的邊界，不解壓內容。
 * @param {Buffer} buffer 完整的 session 檔位元組。
 * @returns {{frames: {start:number,end:number}[], tornStart?: number}}
 */
export function zstdFrameRanges(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 解壓整個串接容器（含被截斷的最後一格）。
 * @param {Buffer} buffer session 檔位元組。
 * @returns {Buffer} 串接後的 JSONL 純文字位元組。
 */
export function decodeZstdContainer(buffer) {
  const { frames, tornStart } = zstdFrameRanges(buffer)
  const parts = frames.map(({ start, end }) => zstdDecompressSync(buffer.subarray(start, end)))
  if (tornStart !== undefined) {
    const tail = buffer.subarray(tornStart)
    if (tail.length > 0) {
      try { parts.push(zstdDecompressSync(tail, { finishFlush: constants.ZSTD_e_flush })) } catch { /* 殘缺尾格可忽略 */ }
    }
  }
  return Buffer.concat(parts)
}

/**
 * 把純文字位元組重新編碼成串接框架容器。每一段各自成為一格並附檢查碼。
 * @param {Buffer[]|Buffer} chunks 純文字位元組。
 * @returns {Buffer} 可直接寫入 session 檔的位元組。
 */
export function encodeZstdContainer(chunks) {
  const list = Array.isArray(chunks) ? chunks : [chunks]
  return Buffer.concat(list.filter(part => part.length > 0).map(part => zstdCompressSync(part, CHECKSUM_OPTIONS)))
}

/** 是否為 Zstandard 串接容器。 */
export function isZstdContainer(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === MAGIC
}

/**
 * 把 session 記錄檔第一格的 header cwd 換成本機路徑，其餘事件格保持位元組不變。
 *
 * DSH 讀取時會驗證 `generationLogPath(root, header.cwd, header.id)` 必須等於檔案
 * 實際路徑，因此跨機還原時 header cwd 必須對應本機的專案目錄，否則會被判定為
 * 損毀的 session log。事件內容（歷史訊息）不動，保留原始紀錄。
 *
 * @param {Buffer} buffer session 檔位元組（Zstandard 串接容器或純文字）。
 * @param {string} targetCwd 本機專案目錄絕對路徑。
 * @returns {{changed: boolean, buffer: Buffer, from?: string}}
 */
export function remapSessionLogCwd(buffer, targetCwd) {
  if (typeof targetCwd !== 'string' || targetCwd.length === 0) return { changed: false, buffer }
  const compressed = isZstdContainer(buffer)
  const { frames, tornStart } = compressed ? zstdFrameRanges(buffer) : { frames: [], tornStart: undefined }
  const headLength = compressed ? (frames[0] ? frames[0].end : 0) : buffer.length
  const headPlain = compressed ? zstdDecompressSync(buffer.subarray(0, headLength)) : buffer
  const headText = headPlain.toString('utf8')
  const newline = headText.indexOf('\n')
  if (newline < 0) return { changed: false, buffer }
  let header
  try { header = JSON.parse(headText.slice(0, newline)) } catch { return { changed: false, buffer } }
  if (typeof header?.cwd !== 'string' || header.cwd === targetCwd) return { changed: false, buffer }
  const from = header.cwd
  const escapedFrom = JSON.stringify(from).slice(1, -1)
  const escapedTo = JSON.stringify(targetCwd).slice(1, -1)
  if (!headText.slice(0, newline).includes(escapedFrom)) return { changed: false, buffer }
  const nextHead = Buffer.from(headText.slice(0, newline).replace(escapedFrom, escapedTo) + headText.slice(newline), 'utf8')
  const next = compressed
    ? Buffer.concat([encodeZstdContainer(nextHead), buffer.subarray(headLength)])
    : nextHead
  if (tornStart !== undefined) return { changed: false, buffer }
  return { changed: true, buffer: next, from }
}
