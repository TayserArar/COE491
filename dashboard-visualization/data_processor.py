#!/usr/bin/env python3
"""
DANS ILS Data Processor
-----------------------
Watches a folder for .log files and processes them into clean JSON data
for visualization in the dashboard.

Usage:
    python data_processor.py /path/to/log/folder
    python data_processor.py /path/to/log/folder --output processed_data.json
    python data_processor.py /path/to/log/folder --once  # Process once without watching

The processor:
1. Watches for new/modified .log files
2. Parses the NORMARC 7000 log format
3. Extracts all numerical measurement columns
4. Strips status columns (A, W, a, w, *, #, ?)
5. Outputs clean JSON data
"""

import os
import sys
import json
import time
import re
import argparse
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Any

# Try to import watchdog for file watching
try:
    from watchdog.observers import Observer
    from watchdog.events import FileSystemEventHandler
    WATCHDOG_AVAILABLE = True
except ImportError:
    WATCHDOG_AVAILABLE = False
    print("[Warning] watchdog not installed. Install with: pip install watchdog")
    print("[Warning] Running in single-process mode without file watching.")


class LogFileProcessor:
    """Processes NORMARC 7000 ContMon log files"""
    
    # Number of header lines to skip in log files
    HEADER_LINES = 16
    
    def __init__(self, output_path: str = 'processed_data.json'):
        self.output_path = output_path
        self.processed_files: Dict[str, float] = {}
        
    def detect_equipment_type(self, columns: List[str]) -> str:
        """Detect if file is GP or LLZ based on columns"""
        col_str = ' '.join(columns)
        if 'CL ID MOD' in col_str or 'ID MOD' in col_str:
            return 'LLZ'
        return 'GP'
    
    def parse_log_file(self, file_path: str) -> Optional[Dict[str, Any]]:
        """Parse a single log file and return structured data."""
        try:
            with open(file_path, 'r', encoding='latin-1') as f:
                lines = f.readlines()
            
            if len(lines) < self.HEADER_LINES + 2:
                print(f"[Processor] File too short: {file_path}")
                return None
            
            # Find the header line (starts with "Timestamp")
            header_line = None
            header_idx = self.HEADER_LINES
            
            for i, line in enumerate(lines):
                if line.strip().startswith('Timestamp'):
                    header_line = line.strip()
                    header_idx = i
                    break
            
            if not header_line:
                print(f"[Processor] No header found in: {file_path}")
                return None
            
            # Parse header columns
            all_columns = header_line.split('\t')
            
            # Detect equipment type
            equipment_type = self.detect_equipment_type(all_columns)
            
            # Identify measurement columns (not Status columns)
            measurement_columns = []
            measurement_indices = []
            status_indices = []
            
            for i, col in enumerate(all_columns):
                col_clean = col.strip()
                if col_clean == 'Timestamp':
                    measurement_columns.append('timestamp')
                    measurement_indices.append(i)
                elif col_clean == 'Status' or col_clean.endswith('Status'):
                    status_indices.append(i)
                elif col_clean and col_clean != 'Status':
                    clean_name = self._clean_column_name(col_clean)
                    measurement_columns.append(clean_name)
                    measurement_indices.append(i)
            
            # Parse data lines
            records = []
            status_counts = {'normal': 0, 'warning': 0, 'alarm': 0, 'error': 0}
            
            for line in lines[header_idx + 1:]:
                line = line.strip()
                if not line:
                    continue
                
                values = line.split('\t')
                if len(values) < 2:
                    continue
                
                # Parse timestamp
                timestamp_str = values[0].strip() if values else ''
                if not timestamp_str or not timestamp_str[0].isdigit():
                    continue
                
                # Skip invalid timestamps (year 1990 indicates error)
                if timestamp_str.startswith('1990'):
                    continue
                
                record = {'timestamp': timestamp_str}
                
                # Extract measurement values
                for col_name, col_idx in zip(measurement_columns[1:], measurement_indices[1:]):
                    if col_idx < len(values):
                        val_str = values[col_idx].strip()
                        try:
                            record[col_name] = float(val_str)
                        except (ValueError, TypeError):
                            record[col_name] = None
                
                # Count statuses
                for status_idx in status_indices:
                    if status_idx < len(values):
                        status_val = values[status_idx].strip()
                        if status_val in ('a', 'A'):
                            status_counts['alarm'] += 1
                        elif status_val in ('w', 'W'):
                            status_counts['warning'] += 1
                        elif status_val in ('*', '?', '#'):
                            status_counts['error'] += 1
                        else:
                            status_counts['normal'] += 1
                
                records.append(record)
            
            if not records:
                print(f"[Processor] No valid records in: {file_path}")
                return None
            
            # Extract date from filename
            filename = os.path.basename(file_path)
            date_match = re.search(r'(\d{4}-\d{2}-\d{2})', filename)
            file_date = date_match.group(1) if date_match else datetime.now().strftime('%Y-%m-%d')
            
            # Detect period (a=morning, b=afternoon)
            period_match = re.search(r'-([ab])\.log', filename, re.IGNORECASE)
            period = 'morning' if period_match and period_match.group(1).lower() == 'a' else 'afternoon'
            
            return {
                'filename': filename,
                'filepath': file_path,
                'equipment_type': equipment_type,
                'date': file_date,
                'period': period,
                'record_count': len(records),
                'columns': measurement_columns,
                'status_counts': status_counts,
                'time_range': {
                    'start': records[0]['timestamp'] if records else None,
                    'end': records[-1]['timestamp'] if records else None
                },
                'records': records
            }
            
        except Exception as e:
            print(f"[Processor] Error parsing {file_path}: {e}")
            import traceback
            traceback.print_exc()
            return None
    
    def _clean_column_name(self, col_name: str) -> str:
        """Clean column name for use as JSON key"""
        name = col_name.strip()
        name = name.replace('µ', 'u')
        name = name.replace('°', 'deg')
        name = name.replace('%', 'pct')
        name = name.replace('(', '_').replace(')', '')
        name = name.replace(' ', '_')
        name = name.replace('/', '_')
        while '__' in name:
            name = name.replace('__', '_')
        name = name.rstrip('_')
        return name
    
    def process_folder(self, folder_path: str) -> Dict[str, Any]:
        """Process all log files in a folder."""
        folder = Path(folder_path)
        if not folder.exists():
            print(f"[Processor] Folder not found: {folder_path}")
            return {'error': 'Folder not found', 'files': []}
        
        log_files = list(folder.glob('*.log')) + list(folder.glob('*.LOG'))
        
        if not log_files:
            print(f"[Processor] No log files found in: {folder_path}")
            return {'files': [], 'total_records': 0}
        
        processed_data = {
            'processed_at': datetime.now().isoformat(),
            'source_folder': str(folder_path),
            'files': [],
            'total_records': 0,
            'all_columns': set(),
            'combined_records': []
        }
        
        for log_file in sorted(log_files):
            file_path = str(log_file)
            print(f"[Processor] Processing: {log_file.name}")
            result = self.parse_log_file(file_path)
            
            if result:
                file_mtime = os.path.getmtime(file_path)
                self.processed_files[file_path] = file_mtime
                
                file_summary = {k: v for k, v in result.items() if k != 'records'}
                processed_data['files'].append(file_summary)
                processed_data['all_columns'].update(result['columns'])
                
                for record in result['records']:
                    record['_source_file'] = result['filename']
                    record['_equipment_type'] = result['equipment_type']
                    record['_date'] = result['date']
                    record['_period'] = result['period']
                    processed_data['combined_records'].append(record)
                
                processed_data['total_records'] += result['record_count']
        
        processed_data['all_columns'] = sorted(list(processed_data['all_columns']))
        return processed_data
    
    def save_output(self, data: Dict[str, Any]) -> bool:
        """Save processed data to JSON file"""
        try:
            output = {
                'metadata': {
                    'processed_at': data.get('processed_at', datetime.now().isoformat()),
                    'source_folder': data.get('source_folder', ''),
                    'total_records': data.get('total_records', 0),
                    'file_count': len(data.get('files', [])),
                    'columns': data.get('all_columns', [])
                },
                'files': data.get('files', []),
                'records': data.get('combined_records', [])
            }
            
            with open(self.output_path, 'w', encoding='utf-8') as f:
                json.dump(output, f, indent=2, ensure_ascii=False)
            
            print(f"[Processor] Saved {output['metadata']['total_records']} records to {self.output_path}")
            return True
        except Exception as e:
            print(f"[Processor] Error saving output: {e}")
            return False


class LogFileWatcher(FileSystemEventHandler):
    """Watches folder for log file changes"""
    
    def __init__(self, processor: LogFileProcessor, folder_path: str):
        self.processor = processor
        self.folder_path = folder_path
        self.last_process_time = 0
        self.debounce_seconds = 2
        
    def on_created(self, event):
        if event.is_directory:
            return
        if event.src_path.lower().endswith('.log'):
            print(f"[Watcher] New file: {os.path.basename(event.src_path)}")
            self._schedule_processing()
    
    def on_modified(self, event):
        if event.is_directory:
            return
        if event.src_path.lower().endswith('.log'):
            print(f"[Watcher] Modified: {os.path.basename(event.src_path)}")
            self._schedule_processing()
    
    def _schedule_processing(self):
        current_time = time.time()
        if current_time - self.last_process_time > self.debounce_seconds:
            self.last_process_time = current_time
            time.sleep(0.5)
            self._process()
    
    def _process(self):
        print("[Watcher] Processing files...")
        data = self.processor.process_folder(self.folder_path)
        self.processor.save_output(data)


def main():
    parser = argparse.ArgumentParser(
        description='DANS ILS Log File Processor'
    )
    parser.add_argument('folder', help='Path to folder containing .log files')
    parser.add_argument('--output', '-o', default='processed_data.json',
                        help='Output JSON file path')
    parser.add_argument('--once', action='store_true',
                        help='Process once and exit')
    
    args = parser.parse_args()
    
    folder_path = os.path.abspath(args.folder)
    output_path = os.path.abspath(args.output)
    
    print("=" * 60)
    print("DANS ILS Data Processor")
    print("=" * 60)
    print(f"Watch Folder: {folder_path}")
    print(f"Output File:  {output_path}")
    print("=" * 60)
    
    processor = LogFileProcessor(output_path)
    
    print("\n[Processor] Initial scan...")
    data = processor.process_folder(folder_path)
    processor.save_output(data)
    
    if args.once:
        print("\n[Processor] Single run complete.")
        return
    
    if not WATCHDOG_AVAILABLE:
        print("\n[Error] Install watchdog: pip install watchdog")
        return
    
    print("\n[Watcher] Starting... Press Ctrl+C to stop\n")
    
    event_handler = LogFileWatcher(processor, folder_path)
    observer = Observer()
    observer.schedule(event_handler, folder_path, recursive=False)
    observer.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[Watcher] Stopping...")
        observer.stop()
    
    observer.join()
    print("[Watcher] Stopped.")


if __name__ == '__main__':
    main()
