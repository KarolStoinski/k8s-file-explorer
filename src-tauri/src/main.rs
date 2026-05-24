#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    k8s_file_explorer_lib::run();
}
