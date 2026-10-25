import AVFoundation
import AppKit

let args = CommandLine.arguments
let framesDir = args[1], count = Int(args[2])!, fps = Int32(args[3])!, wavPath = args[4], outPath = args[5]
let outURL = URL(fileURLWithPath: outPath)
try? FileManager.default.removeItem(at: outURL)
let writer = try! AVAssetWriter(outputURL: outURL, fileType: .mp4)

let vSettings: [String: Any] = [
  AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1920, AVVideoHeightKey: 1080,
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 16_000_000, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
    AVVideoMaxKeyFrameIntervalKey: 60, AVVideoExpectedSourceFrameRateKey: Int(fps)],
  AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
]
let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
vIn.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 1920, kCVPixelBufferHeightKey as String: 1080])
writer.add(vIn)

let aSettings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000]
let aIn = AVAssetWriterInput(mediaType: .audio, outputSettings: aSettings)
aIn.expectsMediaDataInRealTime = false
writer.add(aIn)

let asset = AVURLAsset(url: URL(fileURLWithPath: wavPath))
let reader = try! AVAssetReader(asset: asset)
let aTrack = asset.tracks(withMediaType: .audio)[0]
let aOut = AVAssetReaderTrackOutput(track: aTrack, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false])
reader.add(aOut)
reader.startReading()

writer.startWriting()
writer.startSession(atSourceTime: .zero)

let cs = CGColorSpace(name: CGColorSpace.sRGB)!
func pixelBuffer(_ path: String) -> CVPixelBuffer {
  let img = NSImage(contentsOfFile: path)!
  var rect = CGRect(x: 0, y: 0, width: 1920, height: 1080)
  let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil)!
  var pb: CVPixelBuffer?
  CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &pb)
  let buf = pb!
  CVPixelBufferLockBaseAddress(buf, [])
  let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buf), width: 1920, height: 1080, bitsPerComponent: 8,
    bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  ctx.draw(cg, in: CGRect(x: 0, y: 0, width: 1920, height: 1080))
  CVPixelBufferUnlockBaseAddress(buf, [])
  return buf
}

let group = DispatchGroup()
group.enter()
var frame = 0
vIn.requestMediaDataWhenReady(on: DispatchQueue(label: "v")) {
  while vIn.isReadyForMoreMediaData {
    if frame >= count { vIn.markAsFinished(); group.leave(); return }
    let path = String(format: "%@/f%04d.jpg", framesDir, frame)
    autoreleasepool { _ = adaptor.append(pixelBuffer(path), withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: fps)) }
    frame += 1
  }
}
group.enter()
aIn.requestMediaDataWhenReady(on: DispatchQueue(label: "a")) {
  while aIn.isReadyForMoreMediaData {
    if let sb = aOut.copyNextSampleBuffer() { aIn.append(sb) } else { aIn.markAsFinished(); group.leave(); return }
  }
}
group.wait()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
print(writer.status == .completed ? "ok" : "failed: \(String(describing: writer.error))")
