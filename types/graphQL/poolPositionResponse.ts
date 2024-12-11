export type PoolPositionResponse =
    | {
        poolPositions: {
            nodes: {
                id: string;
                height: string;
            }[];
        };
    }
    | undefined;
