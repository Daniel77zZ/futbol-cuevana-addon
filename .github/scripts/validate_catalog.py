#!/usr/bin/env python3
import json
import sys

def validate_catalog(filepath, name):
    with open(filepath) as f:
        data = json.load(f)
    print(f'{name} catalog items: {len(data)}')
    for item in data[:5]:
        print(f'  - {item["id"]}: {item["name"]}')
    if len(data) == 0:
        print(f'WARNING: Empty {name} catalog!')
        sys.exit(1)

def validate_stream_result(filepath):
    with open(filepath) as f:
        data = json.load(f)
    if 'error' in data:
        print(f'Extraction failed: {data["error"]}')
        sys.exit(1)
    if 'hls' not in data:
        print('ERROR: No HLS URL in result')
        sys.exit(1)
    print(f'Successfully extracted HLS: {data["hls"]}')
    print(f'Quality: {data.get("quality", "unknown")}')

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(f'Usage: {sys.argv[0]} <command> [args...]')
        print('Commands:')
        print('  validate_catalog <json_file> <catalog_name>')
        print('  validate_stream <json_file>')
        sys.exit(1)

    command = sys.argv[1]
    if command == 'validate_catalog':
        if len(sys.argv) != 4:
            print(f'Usage: {sys.argv[0]} validate_catalog <json_file> <catalog_name>')
            sys.exit(1)
        validate_catalog(sys.argv[2], sys.argv[3])
    elif command == 'validate_stream':
        if len(sys.argv) != 3:
            print(f'Usage: {sys.argv[0]} validate_stream <json_file>')
            sys.exit(1)
        validate_stream_result(sys.argv[2])
    else:
        print(f'Unknown command: {command}')
        sys.exit(1)