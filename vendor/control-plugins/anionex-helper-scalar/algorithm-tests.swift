private func keyboardTextChunks(_ text: String) -> [String] {
    text.unicodeScalars.map { String($0) }
}


@main struct AlgorithmTests {
    static func main() {
        let ascii32 = String(repeating: "A", count: 32)
        let chinese = String(repeating: "中", count: 21)
        let pairs = String(repeating: "😀", count: 11)
        let edge = String(repeating: "A", count: 19) + "😀Z"
        let zwj = String(repeating: "👨‍👩‍👧‍👦", count: 4)
        let cases = [ascii32, chinese, pairs, edge, zwj, "", String(repeating: "Z", count: 20)]
        for value in cases {
            let chunks = keyboardTextChunks(value)
            precondition(chunks.joined() == value)
            precondition(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= 2 })
            precondition(chunks.flatMap { $0.unicodeScalars.map(\.value) } == value.unicodeScalars.map(\.value))
        }
        precondition(keyboardTextChunks(ascii32).map { $0.utf16.count } == Array(repeating: 1, count: 32))
        precondition(keyboardTextChunks(chinese).map { $0.utf16.count } == Array(repeating: 1, count: 21))
        precondition(keyboardTextChunks(pairs).map { $0.utf16.count } == Array(repeating: 2, count: 11))
        precondition(keyboardTextChunks(edge).map { $0.utf16.count } == Array(repeating: 1, count: 19) + [2, 1])
        precondition(keyboardTextChunks("").isEmpty)
        print("{\"ok\":true,\"cases\":7,\"guiExecuted\":false}")
    }
}
