import { RpcStub } from '@cloudflare/jsrpc'
import { AuthenticatedApi } from '@minions/workshop-shared/api'
import {
  Box,
  AppBar,
  Toolbar,
  Typography,
  Button,
  Container,
  Paper,
  Grid,
} from '@mui/material'
import { LogoutOutlined } from '@mui/icons-material'

interface HomeProps {
  authenticatedApi: RpcStub<AuthenticatedApi>
  onLogout: () => void
}

export default function Home({ onLogout }: HomeProps) {
  return (
    <Box sx={{ flexGrow: 1 }}>
      <AppBar position="static" sx={{ mb: 4 }}>
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Minions Workshop
          </Typography>
          <Button
            color="inherit"
            startIcon={<LogoutOutlined />}
            onClick={onLogout}
          >
            Logout
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="lg">
        <Paper
          sx={{
            p: 4,
            mb: 4,
            textAlign: 'center',
            background: 'linear-gradient(135deg, #f5f7fa 0%, #c3cfe2 100%)',
          }}
        >
          <Typography variant="h4" gutterBottom fontWeight="bold">
            Welcome to your Workshop!
          </Typography>
          <Typography variant="h6" color="text.secondary" gutterBottom>
            You are successfully logged in and authenticated.
          </Typography>
          <Typography variant="body1" color="text.secondary">
            This is where you'll manage your minions and create new ones.
          </Typography>
        </Paper>

        <Grid container spacing={3}>
          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="h6" gutterBottom>
                Your Minions
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Manage and view all your AI assistants
              </Typography>
              <Button variant="outlined" fullWidth>
                View All Minions
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="h6" gutterBottom>
                Create New Minion
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Start building a new AI assistant
              </Typography>
              <Button variant="contained" fullWidth>
                Create Minion
              </Button>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6} lg={4}>
            <Paper sx={{ p: 3, textAlign: 'center' }}>
              <Typography variant="h6" gutterBottom>
                Blueprints
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                Browse and use templates
              </Typography>
              <Button variant="outlined" fullWidth>
                Browse Blueprints
              </Button>
            </Paper>
          </Grid>
        </Grid>
      </Container>
    </Box>
  )
}