import SwiftUI
import UIKit

// This measures only the overlap left after SwiftUI's own keyboard avoidance.
// The reader is outside the padding and attached to a frame that fills the
// parent's proposal, so changing the inset does not move its measuring edge.
struct ComposerKeyboardAvoidance: ViewModifier {
    let enabled: Bool
    @State private var residual: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .padding(.bottom, enabled ? residual : 0)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background {
                KeyboardResidualReader(enabled: enabled) { residual = $0 }
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
    }
}

enum KeyboardBottomOverlap {
    static func inset(container: CGRect, window: CGRect, keyboard: CGRect?, displayScale: CGFloat) -> CGFloat {
        func valid(_ rect: CGRect) -> Bool {
            [rect.minX, rect.minY, rect.maxX, rect.maxY, rect.width, rect.height].allSatisfy { $0.isFinite } &&
                rect.width > 0 && rect.height > 0
        }
        guard valid(container), valid(window), let keyboard, valid(keyboard) else { return 0 }
        let visibleContainer = container.intersection(window)
        let obstruction = keyboard.intersection(window)
        guard !visibleContainer.isNull, !visibleContainer.isEmpty,
              !obstruction.isNull, !obstruction.isEmpty else { return 0 }

        let scale = displayScale.isFinite && displayScale > 0 ? displayScale : 1
        let pixel = 1 / scale
        // A floating/undocked keyboard is not a full-width bottom inset.
        guard obstruction.minX <= window.minX + pixel,
              obstruction.maxX >= window.maxX - pixel,
              obstruction.maxY >= window.maxY - pixel else { return 0 }
        let overlap = max(0, visibleContainer.maxY - max(visibleContainer.minY, obstruction.minY))
        return min(visibleContainer.height, (overlap * scale).rounded(.up) / scale)
    }
}

@MainActor
private struct KeyboardResidualReader: UIViewRepresentable {
    let enabled: Bool
    let onChange: (CGFloat) -> Void

    func makeUIView(context: Context) -> KeyboardResidualView {
        let view = KeyboardResidualView()
        view.isUserInteractionEnabled = false
        view.isAccessibilityElement = false
        view.accessibilityElementsHidden = true
        view.backgroundColor = .clear
        view.configure(enabled: enabled, onChange: onChange)
        view.observeKeyboard()
        return view
    }

    func updateUIView(_ uiView: KeyboardResidualView, context: Context) {
        uiView.configure(enabled: enabled, onChange: onChange)
    }

    static func dismantleUIView(_ uiView: KeyboardResidualView, coordinator: Void) {
        uiView.invalidate()
    }
}

// Foundation removes these block observers safely even if the view is
// destroyed without another didMoveToWindow callback.
private final class KeyboardObserverTokens {
    var values: [NSObjectProtocol] = []
    func removeAll() {
        for token in values { NotificationCenter.default.removeObserver(token) }
        values.removeAll()
    }
    deinit { removeAll() }
}

@MainActor
private final class KeyboardResidualView: UIView {
    private let observers = KeyboardObserverTokens()
    private var enabled = false
    private var onChange: ((CGFloat) -> Void)?
    private var keyboardEndFrame: CGRect?
    private var keyboardScreen: UIScreen?
    private weak var lastAttachedWindow: UIWindow?
    private var attachedBefore = false
    private var pendingUpdate: DispatchWorkItem?
    private var lastPublished: CGFloat?
    private var invalidated = false

    func configure(enabled: Bool, onChange: @escaping (CGFloat) -> Void) {
        self.enabled = enabled
        self.onChange = onChange
        scheduleUpdate()
    }

    func observeKeyboard() {
        guard observers.values.isEmpty else { return }
        let names: [Notification.Name] = [
            UIResponder.keyboardWillChangeFrameNotification,
            UIResponder.keyboardDidChangeFrameNotification,
            UIResponder.keyboardWillHideNotification,
            UIResponder.keyboardDidHideNotification,
            UIWindow.didBecomeKeyNotification,
            UIWindow.didResignKeyNotification,
            UIScene.didActivateNotification,
            UIScene.willDeactivateNotification
        ]
        for name in names {
            observers.values.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                MainActor.assumeIsolated { self?.receive(notification) }
            })
        }
    }

    private func receive(_ notification: Notification) {
        if notification.name == UIWindow.didBecomeKeyNotification || notification.name == UIWindow.didResignKeyNotification {
            guard let eventWindow = notification.object as? UIWindow, eventWindow === window else { return }
            scheduleUpdate()
            return
        }
        if notification.name == UIScene.didActivateNotification || notification.name == UIScene.willDeactivateNotification {
            guard let scene = notification.object as? UIWindowScene, scene === window?.windowScene else { return }
            scheduleUpdate()
            return
        }
        let eventScreen = notification.object as? UIScreen
        if let receivingWindow = window ?? lastAttachedWindow, let eventScreen,
           eventScreen !== (receivingWindow.windowScene?.screen ?? receivingWindow.screen) { return }
        if (notification.userInfo?[UIResponder.keyboardIsLocalUserInfoKey] as? Bool) == false { return }
        if notification.name == UIResponder.keyboardWillHideNotification || notification.name == UIResponder.keyboardDidHideNotification {
            keyboardEndFrame = nil
            keyboardScreen = nil
        } else {
            keyboardEndFrame = (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
            keyboardScreen = eventScreen
        }
        scheduleUpdate()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if let window {
            // Keep a screen-frame observation through a temporary detach from
            // the same window. A replacement (or deallocated prior window)
            // must establish its own keyboard observation before correction.
            if attachedBefore && lastAttachedWindow !== window {
                keyboardEndFrame = nil
                keyboardScreen = nil
            }
            lastAttachedWindow = window
            attachedBefore = true
        }
        scheduleUpdate()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        scheduleUpdate()
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        scheduleUpdate()
    }

    private func scheduleUpdate() {
        guard !invalidated, pendingUpdate == nil else { return }
        // Coalesce lifecycle/notification bursts, and never publish SwiftUI
        // state from inside updateUIView or layoutSubviews.
        let update = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, !self.invalidated else { return }
                self.pendingUpdate = nil
                self.publishCurrentInset()
            }
        }
        pendingUpdate = update
        DispatchQueue.main.async(execute: update)
    }

    private func publishCurrentInset() {
        var next: CGFloat = 0
        if enabled, let window, window.isKeyWindow,
           window.windowScene?.activationState == .foregroundActive,
           let keyboardEndFrame {
            let screen = window.windowScene?.screen ?? window.screen
            if keyboardScreen == nil || keyboardScreen === screen {
                let keyboard = window.convert(keyboardEndFrame, from: (keyboardScreen ?? screen).coordinateSpace)
                next = KeyboardBottomOverlap.inset(
                    container: convert(bounds, to: window),
                    window: window.bounds,
                    keyboard: keyboard,
                    displayScale: screen.scale
                )
            }
        }
        guard next != lastPublished else { return }
        lastPublished = next
        onChange?(next)
    }

    func invalidate() {
        invalidated = true
        pendingUpdate?.cancel()
        pendingUpdate = nil
        observers.removeAll()
        onChange = nil
        keyboardEndFrame = nil
        keyboardScreen = nil
    }
}
