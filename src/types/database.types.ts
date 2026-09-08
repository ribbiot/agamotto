export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  agamotto: {
    Tables: {
      configured_repos: {
        Row: {
          active: boolean
          auto_start: boolean
          created_at: string
          id: string
          name: string
          owner: string
          updated_at: string
          webhook_secret: string | null
        }
        Insert: {
          active?: boolean
          auto_start?: boolean
          created_at?: string
          id?: string
          name: string
          owner: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Update: {
          active?: boolean
          auto_start?: boolean
          created_at?: string
          id?: string
          name?: string
          owner?: string
          updated_at?: string
          webhook_secret?: string | null
        }
        Relationships: []
      }
      memories: {
        Row: {
          content: string
          context: string
          created_at: string
          id: string
          tags: string[]
        }
        Insert: {
          content: string
          context?: string
          created_at?: string
          id?: string
          tags?: string[]
        }
        Update: {
          content?: string
          context?: string
          created_at?: string
          id?: string
          tags?: string[]
        }
        Relationships: []
      }
      review_checkpoints: {
        Row: {
          agent_name: string | null
          id: string
          message: string | null
          passed: boolean
          payload: Json | null
          recorded_at: string
          review_id: string
          stage: string
        }
        Insert: {
          agent_name?: string | null
          id?: string
          message?: string | null
          passed: boolean
          payload?: Json | null
          recorded_at?: string
          review_id: string
          stage: string
        }
        Update: {
          agent_name?: string | null
          id?: string
          message?: string | null
          passed?: boolean
          payload?: Json | null
          recorded_at?: string
          review_id?: string
          stage?: string
        }
        Relationships: []
      }
      review_history: {
        Row: {
          author: string
          finding_count: number
          id: string
          pr_title: string
          pr_url: string
          raw_json: Json
          repo_name: string
          reviewed_at: string
          summary: string
        }
        Insert: {
          author: string
          finding_count?: number
          id?: string
          pr_title: string
          pr_url: string
          raw_json?: Json
          repo_name: string
          reviewed_at?: string
          summary?: string
        }
        Update: {
          author?: string
          finding_count?: number
          id?: string
          pr_title?: string
          pr_url?: string
          raw_json?: Json
          repo_name?: string
          reviewed_at?: string
          summary?: string
        }
        Relationships: []
      }
      reviews: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          mode: string
          pr_metadata: Json
          pr_url: string
          result: Json | null
          status: string
          submission: Json | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id: string
          mode?: string
          pr_metadata?: Json
          pr_url: string
          result?: Json | null
          status?: string
          submission?: Json | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          mode?: string
          pr_metadata?: Json
          pr_url?: string
          result?: Json | null
          status?: string
          submission?: Json | null
          updated_at?: string
        }
        Relationships: []
      }
      settings: {
        Row: {
          key: string
          updated_at: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          value?: Json
        }
        Update: {
          key?: string
          updated_at?: string
          value?: Json
        }
        Relationships: []
      }
      tracked_prs: {
        Row: {
          created_at: string
          id: string
          last_review_id: string | null
          owner: string
          pr_author: string | null
          pr_closed_at: string | null
          pr_number: number
          pr_opened_at: string | null
          pr_title: string | null
          pr_url: string
          repo: string
          review_count: number
          source: string
          status: string
          updated_at: string
          updated_since_review: boolean
        }
        Insert: {
          created_at?: string
          id?: string
          last_review_id?: string | null
          owner: string
          pr_author?: string | null
          pr_closed_at?: string | null
          pr_number: number
          pr_opened_at?: string | null
          pr_title?: string | null
          pr_url: string
          repo: string
          review_count?: number
          source?: string
          status?: string
          updated_at?: string
          updated_since_review?: boolean
        }
        Update: {
          created_at?: string
          id?: string
          last_review_id?: string | null
          owner?: string
          pr_author?: string | null
          pr_closed_at?: string | null
          pr_number?: number
          pr_opened_at?: string | null
          pr_title?: string | null
          pr_url?: string
          repo?: string
          review_count?: number
          source?: string
          status?: string
          updated_at?: string
          updated_since_review?: boolean
        }
        Relationships: [
          {
            foreignKeyName: 'tracked_prs_last_review_id_fkey'
            columns: ['last_review_id']
            isOneToOne: false
            referencedRelation: 'reviews'
            referencedColumns: ['id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] &
        DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] &
        DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema['Tables']
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema['Enums']
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema['CompositeTypes']
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  agamotto: {
    Enums: {},
  },
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
