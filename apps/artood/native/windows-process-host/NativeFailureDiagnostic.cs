// Candidate diagnostics only. A diagnostic is never authority or a successful ACK.
using System.ComponentModel;
using System.Text.Json;

internal sealed record NativeFailureDiagnostic(int Version, string Phase, string Code, int? NativeError)
{
    private static readonly HashSet<string> Phases = new(StringComparer.Ordinal) {
        "guardian_bootstrap", "guardian_lifetime", "guardian_observe", "guardian_peer_open",
        "guardian_client_read", "guardian_request_handle", "guardian_client_reply",
        "guardian_relay_input", "guardian_relay_send", "guardian_relay_output",
        "guardian_connect", "guardian_server_identity", "guardian_request_write",
        "guardian_response_read", "guardian_response_binding", "supervisor_run",
        "supervisor_qualify", "supervisor_peer_open", "supervisor_query_read",
        "supervisor_query_qualify", "supervisor_query_reply"
    };
    // Exact local guard codes only. Exception messages, paths, argv and environment
    // are never copied. Unknown managed exceptions receive a fixed category.
    private static readonly HashSet<string> Codes = new(StringComparer.Ordinal) {
        "guardian_activation_binding", "guardian_attach_epoch", "guardian_attach_identity_changed",
        "guardian_attach_identity", "guardian_audit_bound", "guardian_bootstrap_parent",
        "guardian_bootstrap_supervisor", "guardian_bootstrap", "guardian_client_pid",
        "guardian_command_line_bound", "guardian_command_line_buffer", "guardian_command_line_missing",
        "guardian_command_line_parse", "guardian_command_line_query", "guardian_complete_transfer_frame_bound",
        "guardian_control_store_overlap", "guardian_directory_alias", "guardian_directory_final_path",
        "guardian_directory_handle", "guardian_directory_reparse", "guardian_endpoint", "guardian_enrollment",
        "guardian_exact_host", "guardian_exact_process_wait", "guardian_exact_server_identity",
        "guardian_exact_supervisor_required", "guardian_frame_limit", "guardian_image_query",
        "guardian_job_query", "guardian_local_directory_required", "guardian_lost", "guardian_parent_query",
        "guardian_peer_eof", "guardian_pipe_acl", "guardian_pipe_create", "guardian_process_open",
        "guardian_process_sid", "guardian_process_times", "guardian_process_token", "guardian_relay_image",
        "guardian_relay_parent", "guardian_relay_version", "guardian_request_rejected", "guardian_request",
        "guardian_reservation_binding", "guardian_root_epoch", "guardian_root_identity", "guardian_server_operation_binding",
        "guardian_server_pid", "guardian_slot_epoch", "guardian_terminal_ack_binding", "guardian_terminal_ack",
        "guardian_terminal_changed", "guardian_terminal_incomplete", "guardian_terminal_missing", "guardian_terminal_root",
        "guardian_terminal_unenrolled_root", "guardian_transfer_binding", "guardian_transfer_daemon_changed", "guardian_transfer_replay",
        "supervisor_attribute_size", "supervisor_attributes", "supervisor_client_pid", "supervisor_command_bound",
        "supervisor_control", "supervisor_created_handle_identity", "supervisor_daemon_create", "supervisor_daemon_resume",
        "supervisor_environment_duplicate", "supervisor_environment", "supervisor_exact_kernel_parent", "supervisor_file_acl_bound",
        "supervisor_file_acl_type", "supervisor_file_acl", "supervisor_file_alias", "supervisor_file_bytes_changed",
        "supervisor_file_external_writer", "supervisor_file_handle", "supervisor_file_identity_changed", "supervisor_file_owner",
        "supervisor_file_pin", "supervisor_file_reparse_or_links", "supervisor_fixed_launch", "supervisor_handle_list",
        "supervisor_input_bound", "supervisor_input_generation", "supervisor_input_queue", "supervisor_input_write",
        "supervisor_interrupt_generation", "supervisor_original_child_peer", "supervisor_original_current_daemon_handle",
        "supervisor_original_daemon_wait", "supervisor_original_launch_binding", "supervisor_pipe_acl", "supervisor_pipe_create",
        "supervisor_pipe_server_identity", "supervisor_pipe_server_pid", "supervisor_qualifier_mode", "supervisor_qualifier_parent",
        "supervisor_qualify_input", "supervisor_qualify_peer", "supervisor_restart_before_original_exit", "supervisor_stdio_create",
        "supervisor_stop_wait_unconfirmed", "supervisor_system_root", "supervisor_terminate_current", "empty_guardian_frame"
    };
    internal static NativeFailureDiagnostic Capture(string phase, Exception error) {
        string code = error is IOException && Codes.Contains(error.Message) ? error.Message
            : error is OperationCanceledException ? "operation_cancelled"
            : error is TimeoutException ? "timeout"
            : error is UnauthorizedAccessException ? "access_denied"
            : error is JsonException ? "invalid_json"
            : error is Win32Exception ? "win32_error"
            : error is IOException ? "io_error" : "unexpected_error";
        int? nativeError = error is Win32Exception win32 && win32.NativeErrorCode is >= 0 and <= 65535
            ? win32.NativeErrorCode
            : error is IOException && ((uint)error.HResult & 0xFFFF0000u) == 0x80070000u
                ? error.HResult & 0xFFFF : null;
        // Never read a thread's stale last-error value after managed unwinding.
        return new(1, Phases.Contains(phase) ? phase : "unknown_phase", code, nativeError);
    }
    internal static void Emit(string phase, Exception error) {
        try { Console.Error.WriteLine(GuardianWire.Encode(new { version = 1, kind = "native_failure_diagnostic", payload = Capture(phase, error) })); }
        catch { /* Reporting cannot replace the original failure or release ownership. */ }
    }
}
