export interface DataSyncEvent {
    id: string;
    timestamp: string,
    data: Record<string, any>;
}

export interface ApiResponse {
    events: DataSyncEvent[],
    next_cursor: string | null;
}

export interface IngestionState {
    cursor: string | null;
    total_processed: number;
}