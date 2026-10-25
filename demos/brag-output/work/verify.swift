import AVFoundation
import AppKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
print("duration", CMTimeGetSeconds(asset.duration))
for t in asset.tracks { print(t.mediaType.rawValue, "dur", CMTimeGetSeconds(t.timeRange.duration), "size", t.naturalSize, "fps", t.nominalFrameRate, "kbps", Int(t.estimatedDataRate / 1000)) }
let gen = AVAssetImageGenerator(asset: asset)
gen.requestedTimeToleranceBefore = .zero; gen.requestedTimeToleranceAfter = .zero
for s in [0.0, 16.4, 24.4] {
  let img = try! gen.copyCGImage(at: CMTime(seconds: s, preferredTimescale: 600), actualTime: nil)
  let rep = NSBitmapImageRep(cgImage: img)
  try! rep.representation(using: .jpeg, properties: [.compressionFactor: 0.8])!.write(to: URL(fileURLWithPath: "check-\(s).jpg"))
}
