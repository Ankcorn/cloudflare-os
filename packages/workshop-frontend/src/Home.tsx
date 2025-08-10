import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Button,
  Container,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material'
import { LogoutOutlined, Add } from '@mui/icons-material'
import { useAuthenticatedApi } from './AuthContext'
import { useState, useEffect } from 'react'
import { MinionMetadata } from '@minions/workshop-shared/src/api'

export default function Home() {
  const { authenticatedApi, logout } = useAuthenticatedApi()
  const [minions, setMinions] = useState<MinionMetadata[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchMinions = async () => {
      try {
        const minionList = await authenticatedApi.listMinions()
        setMinions(minionList)
      } catch (error) {
        console.error('Failed to fetch minions:', error)
      } finally {
        setLoading(false)
      }
    }

    fetchMinions()
  }, [authenticatedApi])

  const handleLogout = () => {
    logout()
    // No navigation needed - ProtectedRoute will show login overlay
  }

  const handleCreateMinion = async () => {
    try {
      const newMinion = await authenticatedApi.newMinion()
      const metadata = await newMinion.getMetadata()
      setMinions(prev => [...prev, metadata])
    } catch (error) {
      console.error('Failed to create minion:', error)
    }
  }
  return (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar 
        position="static" 
        elevation={0}
        sx={{ 
          mb: 4,
          backgroundColor: 'white',
          borderBottom: '1px solid #e0e0e0',
          color: 'text.primary',
        }}
      >
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Minions Workshop
          </Typography>
          <Button
            color="inherit"
            startIcon={<LogoutOutlined />}
            onClick={handleLogout}
          >
            Logout
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg">
        <Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h4" fontWeight="bold">
            Your Minions
          </Typography>
          <Button
            variant="contained"
            startIcon={<Add />}
            onClick={handleCreateMinion}
            sx={{ minWidth: 150 }}
          >
            New Minion
          </Button>
        </Box>

        <TableContainer component={Paper}>
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Owner</TableCell>
                <TableCell>Last Active</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={3} align="center">
                    Loading minions...
                  </TableCell>
                </TableRow>
              ) : minions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2" color="text.secondary">
                      No minions yet. Create your first minion to get started!
                    </Typography>
                  </TableCell>
                </TableRow>
              ) : (
                minions.map((minion) => (
                  <TableRow 
                    key={minion.id} 
                    hover 
                    sx={{ cursor: 'pointer' }}
                    onClick={() => {
                      // TODO: Navigate to minion editor
                      console.log('Open minion:', minion.id)
                    }}
                  >
                    <TableCell>
                      <Typography variant="body1" fontWeight="medium">
                        {minion.title}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {/* TODO: Add owner information */}
                        —
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {/* TODO: Add last active information */}
                        —
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Container>
    </Box>
  )
}