// WhisperKit latency benchmark: load once, transcribe each fixture N times.
// Usage: wkbench <modelFolder> <ane|gpu|mixed> <runs> <tokenizerDir> <wav>...
// Prints one JSON object per line.
import Foundation
import CoreML
import WhisperKit

func footprintMB() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return kr == KERN_SUCCESS ? Double(info.phys_footprint) / 1_048_576 : -1
}

func emit(_ d: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: d, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

let args = CommandLine.arguments
let modelFolder = args[1], mode = args[2], runs = Int(args[3])!, tokenizerDir = URL(fileURLWithPath: args[4])
let wavs = Array(args.dropFirst(5))

let compute: ModelComputeOptions
switch mode {
case "gpu": compute = ModelComputeOptions(melCompute: .cpuAndGPU, audioEncoderCompute: .cpuAndGPU, textDecoderCompute: .cpuAndGPU)
case "mixed": compute = ModelComputeOptions(melCompute: .cpuAndGPU, audioEncoderCompute: .cpuAndGPU, textDecoderCompute: .cpuAndNeuralEngine)
default: compute = ModelComputeOptions() // library default: encoder + decoder on the Neural Engine
}

let t0 = CFAbsoluteTimeGetCurrent()
let pipe = try await WhisperKit(WhisperKitConfig(
    modelFolder: modelFolder, tokenizerFolder: tokenizerDir, computeOptions: compute,
    verbose: false, logLevel: .error, prewarm: false, load: true, download: false))
let loadS = CFAbsoluteTimeGetCurrent() - t0
let tm = pipe.currentTimings
emit(["event": "load", "mode": mode, "model": URL(fileURLWithPath: modelFolder).lastPathComponent,
      "load_s": loadS, "encoder_load_s": tm.encoderLoadTime, "decoder_load_s": tm.decoderLoadTime,
      "encoder_specialization_s": tm.encoderSpecializationTime, "decoder_specialization_s": tm.decoderSpecializationTime,
      "tokenizer_s": tm.tokenizerLoadTime, "footprint_mb": footprintMB()])

let opts = DecodingOptions(verbose: false, task: .transcribe, language: "en", temperature: 0,
                           usePrefillPrompt: true, skipSpecialTokens: true, withoutTimestamps: false)
var peak = footprintMB()
for wav in wavs {
    for run in 0..<runs {
        let s = CFAbsoluteTimeGetCurrent()
        let results = try await pipe.transcribe(audioPath: wav, decodeOptions: opts)
        let wall = CFAbsoluteTimeGetCurrent() - s
        let text = results.map(\.text).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        let t = results.first?.timings
        peak = max(peak, footprintMB())
        emit(["event": "transcribe", "mode": mode, "fixture": URL(fileURLWithPath: wav).deletingPathExtension().lastPathComponent,
              "run": run, "wall_s": wall, "encoding_s": t?.encoding ?? -1, "decoding_loop_s": t?.decodingLoop ?? -1,
              "windows": t?.totalDecodingWindows ?? -1, "text": text, "footprint_mb": footprintMB()])
    }
}
emit(["event": "done", "peak_footprint_mb": peak])
